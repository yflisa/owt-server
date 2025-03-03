// Copyright (C) <2019> Intel Corporation
//
// SPDX-License-Identifier: Apache-2.0

'use strict';
var logger = require('./logger').logger;
var Scheduler = require('./scheduler').Scheduler;

// Logger
var log = logger.getLogger('ClusterManager');
var role = null;
const http = require('http');
var Url = require("url");

var ClusterManager = function (clusterName, selfId, spec) {
    var that = {name: clusterName,
                id: selfId};

    /*initializing | in-service*/
    var state = 'initializing',
        is_freshman = true,
        monitoringTarget,

        initial_time = spec.initialTime,
        check_alive_period = spec.checkAlivePeriod,
        check_alive_count = spec.checkAliveCount;

    /* {Purpose: Scheduler}*/
    var schedulers = {};

    /*Id : {purpose: Purpose, alive_count: Number}*/
    var workers = {};
    var clusterInfo = {};

    var data_synchronizer;

    function validateUrl(url) {
        try {
            new Url.URL(url);
            return true;
        } catch {
            return false;
        }
    }

    var sendRequest = validateUrl(spec.url);

    var send = function (method, resource, body) {
      log.info("send info to url:", spec.url);
      const data = JSON.stringify(body);
      var url = Url.parse(spec.url + "/" + resource);

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + (url.search ? url.search : ''),
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      };
      log.info("send options:", options);

      const req = http.request(options, res => {
        console.log(`statusCode: ${res.statusCode}`);

        res.on('data', d => {
          process.stdout.write(d);
        });
      });

      req.on('error', error => {
        console.error(error);
      });

      req.write(data);
      req.end();

    }

    var createScheduler = function (purpose) {
        var strategy = spec.strategy[purpose] ? spec.strategy[purpose] : spec.strategy.general;
        return new Scheduler({purpose: purpose, strategy: strategy, scheduleReserveTime: spec.scheduleReserveTime});
    };

    var checkAlive = function () {
        for (var worker in workers) {
            workers[worker].alive_count += 1;
            if (workers[worker].alive_count > check_alive_count) {
                log.info('Worker', worker, 'is not alive any longer, Deleting it.');
                workerQuit(worker);
            }
        }
    };

    var workerJoin = function (purpose, worker, info) {
        log.debug('workerJoin, purpose:', purpose, 'worker:', worker, 'info:', info);
        schedulers[purpose] = schedulers[purpose] || createScheduler(purpose);
        schedulers[purpose].add(worker, info);
        workers[worker] = {purpose: purpose,
                           alive_count: 0};
        if (!clusterInfo[purpose]) {
            clusterInfo[purpose] = new Set()
            var data = {
                clusterID: spec.clusterID,
                region: spec.region,
                info: {
                    action: "add",
                    capacity: purpose
                }
            }
            if (sendRequest) {
                log.info("Send updateCapacity event add to cloud with data:", data);
                send('POST', 'updateCapacity', data);
            }
        }
        clusterInfo[purpose].add(worker);
        data_synchronizer && data_synchronizer({type: 'worker_join', payload: {purpose: purpose, worker: worker, info: info}});
        return state;
    };

    var workerQuit = function (worker) {
        log.debug('workerQuit, worker:', worker);
        var purpose = workers[worker].purpose;
        if (workers[worker] && schedulers[workers[worker].purpose]) {
            schedulers[workers[worker].purpose].remove(worker);
            monitoringTarget && monitoringTarget.notify('quit', {purpose: workers[worker].purpose, id: worker, type: 'worker'});
            delete workers[worker];
            data_synchronizer && data_synchronizer({type: 'worker_quit', payload: {worker: worker}});
        }

        if (purpose) {
            clusterInfo[purpose].delete(worker);
            if(!clusterInfo[purpose]) {
               var data = {
                    clusterID: spec.clusterID,
                    region: spec.region,
                    info: {
                        action: "remove",
                        capacity: purpose
                    }
                }
                if (sendRequest) {
                    log.info("Send updateCapacity event remove to cloud with data:", data);
                    send('POST', 'updateCapacity', data);
                }
            }
        }
    };

    var keepAlive = function (worker, on_result) {
        if (workers[worker]) {
            workers[worker].alive_count = 0;
            on_result('ok');
        } else {
            on_result('whoareyou');
        }
    };

    var reportState = function (worker, state) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].updateState(worker, state);
        data_synchronizer && data_synchronizer({type: 'worker_state', payload: {worker: worker, state: state}});
    };

    var reportLoad = function (worker, load) {
        log.debug('reportLoad, worker:', worker, 'load:', load);
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].updateLoad(worker, load);
        data_synchronizer && data_synchronizer({type: 'worker_load', payload: {worker: worker, load: load}});
    };

    var pickUpTasks = function (worker, tasks) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].pickUpTasks(worker, tasks);
        data_synchronizer && data_synchronizer({type: 'worker_pickup', payload: {worker: worker, tasks: tasks}});
    };

    var layDownTask = function (worker, task) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].layDownTask(worker, task);
        data_synchronizer && data_synchronizer({type: 'worker_laydown', payload: {worker: worker, task: task}});
    };

    var schedule = function (purpose, task, preference, reserveTime, on_ok, on_error) {
        log.debug('schedule, purpose:', purpose, 'task:', task, ', preference:', preference, 'reserveTime:', reserveTime, 'while state:', state);
        if (state === 'in-service') {
            if (schedulers[purpose]) {
                schedulers[purpose].schedule(task, preference, reserveTime, function(worker, info) {
                    log.debug('schedule OK, got  worker', worker);
                    on_ok(worker, info);
                    data_synchronizer && data_synchronizer({type: 'scheduled', payload: {purpose: purpose, task: task, worker: worker, reserve_time: reserveTime}});
                }, function (reason) {
                    log.warn('schedule failed, purpose:', purpose, 'task:', task, 'reason:', reason);
                    on_error('Failed in scheduling ' + purpose + ' worker, reason: ' + reason);
                });
            } else {
                log.warn('No scheduler for purpose:', purpose);
                on_error('No scheduler for purpose: ' + purpose);
            }
        } else {
           log.warn('cluster manager is not ready.');
           on_error('cluster manager is not ready.');
        }
    };

    var unschedule = function (worker, task) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].unschedule(worker, task);
        data_synchronizer && data_synchronizer({type: 'unscheduled', payload: {worker: worker, task: task}});
    };

    var getClusterInfo = function (on_ok) {
        on_ok(Object.keys(clusterInfo));
    };

    var getWorkerAttr = function (worker, on_ok, on_error) {
        if (workers[worker]) {
            var worker_info = schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].getInfo(worker);
            worker_info = worker_info || {state: 0, load: 0, info: {}, tasks: []};
            // FIXME: the following attr items are for purpose of compaticity with legacy oam client, should be refined later.
            if (workers[worker].purpose === 'portal') {
                on_ok({id: worker,
                       purpose: workers[worker].purpose,
                       ip: worker_info.info.ip,
                       rpcID: worker,
                       state: worker_info.state,
                       load: worker_info.load,
                       hostname: worker_info.info.hostname || '',
                       port: worker_info.info.port || 0,
                       keepAlive: workers[worker].alive_count});
            } else {
                on_ok(worker_info);
            }
        } else {
            on_error('Worker [' + worker + '] does NOT exist.');
        }
    };

    var getWorkers = function (purpose, on_ok) {
        if (purpose === 'all') {
            on_ok(Object.keys(workers));
        } else {
            var result = [];
            for (var worker in workers) {
                if (workers[worker].purpose === purpose) {
                    result.push(worker);
                }
            }
            on_ok(result);
        }
    };

    var getTasks = function (worker, on_ok) {
        return workers[worker] && schedulers[workers[worker].purpose] ? schedulers[workers[worker].purpose].getTasks(worker) : [];
    };

    var getScheduled = function (purpose, task, on_ok, on_error) {
        if (schedulers[purpose]) {
            schedulers[purpose].getScheduled(task, on_ok, on_error);
        } else {
            on_error('Invalid purpose.');
        }
    };

    var getClusterID = function (on_ok) {
        return on_ok(spec.clusterID);
    };

    var registerInfo = function (info, on_ok) {
        on_ok('ok');
        var data = {
            clusterID: spec.clusterID,
            region: spec.region,
            info: {
                resturl: info.resturl,
                servicekey: info.servicekey,
                serviceid: info.serviceid
            }
        }
        if (sendRequest) {
            log.info("Send registerCluster event to cloud with data:", data);
            send('POST', 'registerCluster', data);
        }
    };

    var leaveConference = function (info, on_ok) {
        on_ok('ok');
        var data = {
            clusterID: spec.clusterID,
            region: spec.region,
            conferenceId: info
        }
        if (sendRequest) {
            log.info("Send conference leave event to cloud with data:", data);
            send('POST', 'leaveConference', data);
        }
    };

    var unregisterCluster = function () {
        var data = {
            clusterID: spec.clusterID,
            region: spec.region
        }
        if (sendRequest) {
            log.info("Send unregister cluster event to cloud with data:", data);
            send('POST', 'unregisterCluster', data);
        }
    };

    that.stopCluster = function () {
        unregisterCluster();
    }

    that.getRuntimeData = function (on_data) {
        var data = {schedulers: {}, workers: workers};
        for (var purpose in schedulers) {
            data.schedulers[purpose] = schedulers[purpose].getData();
        }
        on_data(data);
    };

    that.registerDataUpdate = function (on_updated_data) {
        data_synchronizer = on_updated_data;
    };

    that.setRuntimeData = function (data) {
         log.debug('onRuntimeData, data:', data);
         if (is_freshman) {
             is_freshman = false;
         }
         workers = data.workers;
         for (var purpose in data.schedulers) {
             schedulers[purpose] = createScheduler(purpose);
             schedulers[purpose].setData(data.schedulers[purpose]);
         }
    };

    that.setUpdatedData = function (data) {
        if (is_freshman) {
            return;
        }
        log.debug('onUpdatedData, data:', data);
        switch (data.type) {
        case 'worker_join':
            workerJoin(data.payload.purpose, data.payload.worker, data.payload.info);
            break;
        case 'worker_quit':
            workerQuit(data.payload.worker);
            break;
        case 'worker_state':
            reportState(data.payload.worker, data.payload.state);
            break;
        case 'worker_load':
            reportLoad(data.payload.worker, data.payload.load);
            break;
        case 'worker_pickup':
            pickUpTasks(data.payload.worker, data.payload.tasks);
            break;
        case 'worker_laydown':
            layDownTask(data.payload.worker, data.payload.task);
            break;
        case 'scheduled':
            schedulers[data.payload.purpose] && schedulers[data.payload.purpose].setScheduled(data.payload.task, data.payload.worker, data.payload.reserve_time);
            break;
        case 'unscheduled':
            unschedule(data.payload.worker, data.payload.task);
            break;
        default:
            log.warn('unknown updated data type:', data.type);
        }
    };

    that.serve = function (monitoringTgt) {
        if (is_freshman) {
            setTimeout(function () {
                state = 'in-service';
            }, initial_time);
        } else {
            state = 'in-service';
        }
        is_freshman = false;
        monitoringTarget = monitoringTgt;
        setInterval(checkAlive, check_alive_period);
        for (var purpose in schedulers) {
            schedulers[purpose].serve();
        }
    };

    that.rpcAPI = {
        join: function (purpose, worker, info, callback) {
            var result = workerJoin(purpose, worker, info);
            callback('callback', result);
        },
        quit: function (worker) {
            workerQuit(worker);
        },
        keepAlive: function (worker, callback) {
            keepAlive(worker, function (result) {
                callback('callback', result);
            });
        },
        reportState: function (worker, state) {
            reportState(worker, state);
        },
        reportLoad: function (worker, load) {
            reportLoad(worker, load);
        },
        pickUpTasks: function (worker, tasks) {
            pickUpTasks(worker, tasks);
        },
        layDownTask: function (worker, task) {
            layDownTask(worker, task);
        },
        schedule: function (purpose, task, preference, reserveTime, callback) {
            schedule(purpose, task, preference, reserveTime, function(worker, info) {
                callback('callback', {id: worker, info: info});
            }, function (error_reason) {
                callback('callback', 'error', error_reason);
            });
        },
        unschedule: function (worker, task) {
            unschedule(worker, task);
        },
        getWorkerAttr: function (worker, callback) {
            getWorkerAttr(worker, function (attr) {
                callback('callback', attr);
            }, function (error_reason) {
                callback('callback', 'error', error_reason);
            });
        },
        getWorkers: function (purpose, callback) {
            getWorkers(purpose, function (workerList) {
                callback('callback', workerList);
            });
        },
        getTasks: function (worker, callback) {
            getTasks(worker, function (taskList) {
                callback('callback', taskList);
            });
        },
        getScheduled: function (purpose, task, callback) {
            getScheduled(purpose, task, function (worker) {
                callback('callback', worker);
            }, function (error_reason) {
                callback('callback', 'error', error_reason);
            });
        },
        getClusterID: function (callback) {
            getClusterID(function (cluster) {
                callback('callback', cluster);
            });
        },
        registerInfo: function (info, callback) {
            registerInfo(info, function (worker) {
                callback('callback', 'ok');
            });
        },
        leaveConference: function (info, callback) {
            leaveConference(info, function (worker) {
                callback('callback', 'ok');
            });
        }
    };

    // API for grpc
    that.grpcInterface = {
        join: function (call, callback) {
            const req = call.request;
            const result = workerJoin(req.purpose, req.id, req.info);
            callback(null, {state: result});
        },
        quit: function(call, callback) {
            workerQuit(call.request.id);
            callback(null, {});
        },
        keepAlive: function(call, callback) {
            keepAlive(call.request.id, function (result) {
                callback(null, {message: result});
            });
        },
        reportState: function (call, callback) {
            reportState(call.request.id, call.request.state);
            callback(null, {});
        },
        reportLoad: function (call, callback) {
            reportLoad(call.request.id, call.request.load);
            callback(null, {});
        },
        pickUpTasks: function (call, callback) {
            pickUpTasks(call.request.id, call.request.tasks);
            callback(null, {});
        },
        layDownTask: function (call, callback) {
            layDownTask(call.request.id, call.request.task);
            callback(null, {});
        },
        schedule: function (call, callback) {
            const purpose = call.request.purpose;
            const task = call.request.task;
            const preference = call.request.preference;
            const reserveTime = call.request.reserveTime;
            schedule(purpose, task, preference, reserveTime, function(worker, info) {
                callback(null, {id: worker, info: info});
            }, function (reason) {
                callback(new Error(reason), null);
            });
        },
        unschedule: function (call, callback) {
            unschedule(call.request.id, call.request.task);
            callback(null, {});
        },
        getWorkerAttr: function (call, callback) {
            getWorkerAttr(call.request.id, function (attr) {
                callback(null, attr);
            }, function (reason) {
                callback(new Error(reason), null);
            });
        },
        getWorkers: function (call, callback) {
            getWorkers(call.request.purpose, function (workerList) {
                callback(null, {list: workerList});
            });
        },
        getTasks: function (call, callback) {
            getTasks(call.request.id, function (taskList) {
                callback(null, {list: taskList});
            });
        },
        getScheduled: function (call, callback) {
            const req = call.request;
            getScheduled(req.purpose, req.task, function (worker) {
                callback(null, {message: worker});
            }, function (reason) {
                callback(new Error(reason), null);
            });
        }
    };

    return that;
};

var runAsSlave = function(topicChannel, manager) {
    var loss_count = 0,
        interval;

    clearRouterKeys(topicChannel,manager);
    role = "slave";

    var requestRuntimeData = function () {
        topicChannel.publish('clusterManager.master', {type: 'requestRuntimeData', data: manager.id});
    };

    var onTopicMessage = function(message) {
        if (message.type === 'runtimeData') {
            manager.setRuntimeData(message.data);
        } else if (message.type === 'updateData') {
            manager.setUpdatedData(message.data);
        } else if (message.type === 'declareMaster') {
            loss_count = 0;
        } else {
            log.info('slave, not concerned message:', message);
        }
    };

    var superviseMaster = function () {
        interval && clearInterval(interval);
        interval = undefined;
        if( role !== "slave"){
            log.warn('cycle in slave change role:', role);
            return;
        }
        interval = setInterval(function () {
            loss_count++;
            if (loss_count > 2) {
                log.info('Lose heart-beat from master.');
                interval && clearInterval(interval);
                interval = undefined;
                role = "candidate";
                //topicChannel.unsubscribe(['clusterManager.slave.#', 'clusterManager.*.' + manager.id]);
                runAsCandidate(topicChannel, manager, 0);
            }
        }, 30);
    };

    log.info('Run as slave.');
    topicChannel.subscribe(['clusterManager.slave.#', 'clusterManager.*.' + manager.id], onTopicMessage, function () {
        requestRuntimeData();
        superviseMaster();
    });
};

var runAsMaster = function(topicChannel, manager) {
    clearRouterKeys(topicChannel);
    log.info('Run as master.');
    var life_time = 0;
    topicChannel.bus.asRpcServer(manager.name, manager.rpcAPI, function(rpcSvr) {
        topicChannel.bus.asMonitoringTarget(function(monitoringTgt) {
            manager.serve(monitoringTgt);
            setInterval(function () {
                life_time += 1;
                //log.info('Send out heart-beat as master.');
                topicChannel.publish('clusterManager.slave', {type: 'declareMaster', data: {id: manager.id, life_time: life_time}});
                topicChannel.publish('clusterManager.candidate', {type: 'declareMaster', data: {id: manager.id, life_time: life_time}});
                topicChannel.publish('clusterManager.master', {type: 'declareMaster', data: {id: manager.id, life_time: life_time}});
            }, 20);

           // var has_got_response = false;
           // setInterval(function () {
           //     if (!has_got_response) {
           //         log.error('Cluster manager lost connection with rabbitMQ server.');
           //         process.exit(1);
           //     }
           //     has_got_response = false;
           // }, 80);

            var onTopicMessage = function (message) {
                //     has_got_response = true;
                if (message.type === 'requestRuntimeData') {
                    var from = message.data;
                    if (from == manager.id){
                        log.error('requestRuntimeData from:', from ,"is yourself");
                        return;
                    }
                    log.info('requestRuntimeData from:', from);
                    manager.getRuntimeData(function (data) {
                        topicChannel.publish('clusterManager.slave.' + from, {type: 'runtimeData', data: data});
                    });
                } else if (message.type === 'declareMaster' && message.data.id !== manager.id) {
                    log.error('!!Double master!! self:', manager.id, 'another:', message.data.id);
                    //FIXME: This occasion should be handled more elegantly.
                    if (message.data.life_time > life_time) {
                        log.error('Another master is more senior than me, I quit.');
                        process.kill(process.pid, 'SIGINT');
                    }
                }
            };

            topicChannel.subscribe(['clusterManager.master.#', 'clusterManager.*.' + manager.id], onTopicMessage, function () {
                log.info('Cluster manager is in service as master!');
                manager.registerDataUpdate(function (data) {
                    topicChannel.publish('clusterManager.slave', {type: 'updateData', data: data});
                });
            });
        }, function(reason) {
            log.error('Cluster manager running as monitoring target failed, reason:', reason);
            process.kill(process.pid, 'SIGINT');
        });
    }, function(reason) {
        log.error('Cluster manager running as RPC server failed, reason:', reason);
        process.kill(process.pid, 'SIGINT');
    });
};

var runAsCandidate = function(topicChannel, manager) {
    var am_i_the_one = true,
        timer,
        interval,
        has_got_response = false;

    clearRouterKeys(topicChannel);
    role = "candidate";

    var electMaster = function () {
        interval && clearInterval(interval);
        interval = undefined;
        timer = undefined;
        //topicChannel.unsubscribe(['clusterManager.candidate.#']);
        if(role !== "candidate"){
            log.warn('cycle in candidate change role:', role);
            return;
        }
        if (am_i_the_one) {
            role = "master";
            log.info('i am the only one run as master');
            runAsMaster(topicChannel, manager);
        } else {
            role = "slave";
            log.info('i am not the only one run as slave');
            runAsSlave(topicChannel, manager);
        }
    };

    var selfRecommend = function () {
        interval && clearInterval(interval);
        interval = undefined;
        if(role !== "candidate"){
            log.warn('cycle in candidate change role:', role);
            return;
        }
        interval = setInterval(function () {
            log.debug('Send self recommendation..');
            topicChannel.publish('clusterManager.candidate', {type: 'selfRecommend', data: manager.id});
        }, 30);
    };

    var onTopicMessage = function (message) {
        if (!has_got_response) {
            timer = setTimeout(electMaster, 160);
            has_got_response = true;
        }

        if (message.type === 'selfRecommend') {
            if (message.data > manager.id) {
                am_i_the_one = false;
            }
        } else if (message.type === 'declareMaster') {
            interval && clearInterval(interval);
            interval = undefined;
            timer && clearTimeout(timer);
            timer = undefined;
            if(role !== "candidate"){
                log.warn('cycle in has select role:',role);
                return;
            }
            role = "slave";
            log.info('Someone else became master.');
            //topicChannel.unsubscribe(['clusterManager.#']);
            runAsSlave(topicChannel, manager);
        }
    };

    log.info('Run as candidate.');
    topicChannel.subscribe(['clusterManager.candidate.#'], onTopicMessage, function () {
        selfRecommend();
    });
};

var clearRouterKeys = function(topicChannel){
    const CANDIDATE_ROUTER_KEY = ["clusterManager.#"];
    topicChannel.unsubscribe(CANDIDATE_ROUTER_KEY);
}

exports.manager = function (topicChannel, clusterName, id, spec) {
    var that = {};
    var manager;

    that.run = function (topicChannel){
        manager = new ClusterManager(clusterName, id, spec);
        runAsCandidate(topicChannel, manager);
    }

    that.leave = function () {
        manager.stopCluster();
    }

    return that;
};

exports.ClusterManager = ClusterManager;
