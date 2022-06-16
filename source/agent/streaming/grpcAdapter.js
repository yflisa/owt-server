// Copyright (C) <2022> Intel Corporation
//
// SPDX-License-Identifier: Apache-2.0

'use strict';

const unpackOption = require('./grpcTools').unpackOption;

// Create GRPC interface for streaming agent
function createGrpcInterface(controller, streamingEmitter) {
  const that = {};

  // GRPC export
  that.grpcInterface = {
    publish: function (call, callback) {
      const req = call.request;
      const option = unpackOption(req.type, req.option);
      controller.publish(req.id, req.type, option, (n, code, data) => {
        if (code === 'error') {
          callback(new Error(data), null);
        } else {
          callback(null, {id: req.id});
        }
      });
    },
    unpublish: function (call, callback) {
      controller.unpublish(call.request.id, (n, code, data) => {
        if (code === 'error') {
          callback(new Error(data), null);
        } else {
          callback(null, {});
        }
      });
    },
    subscribe: function (call, callback) {
      const req = call.request;
      const option = unpackOption(req.type, req.option);
      controller.subscribe(req.id, req.type, option, (n, code, data) => {
        if (code === 'error') {
          callback(new Error(data), null);
        } else {
          callback(null, {id: req.id});
        }
      });
    },
    unsubscribe: function (call, callback) {
      controller.unsubscribe(call.request.id, (n, code, data) => {
        if (code === 'error') {
          callback(new Error(data), null);
        } else {
          callback(null, {});
        }
      });
    },
    linkup: function (call, callback) {
      const req = call.request;
      controller.linkup(
        req.id,
        req.from.audio && req.from.audio.id,
        req.from.video && req.from.video.id,
        req.from.data && req.from.data.id,
        (n, code, data) => {
          if (code === 'error') {
            callback(new Error(data), null);
          } else {
            callback(null, {message: data});
          }
        });
    },
    cutoff: function (call, callback) {
      controller.cutoff(call.request.id, (n, code, data) => {
        if (code === 'error') {
          callback(new Error(data), null);
        } else {
          callback(null, {});
        }
      });
    },
    listenToNotifications: function (call, callback) {
      streamingEmitter.on('notification', (notification) => {
        const progress = {
          type: 'video',
          name: notification.name,
          data: notification.data,
        };
        call.write(progress);
      });
      streamingEmitter.on('close', () => {
        call.end();
      });
    },
    createInternalConnection: function (call, callback) {
      const req = call.request;
      controller.createInternalConnection(
        req.id,
        req.direction,
        req.internalOpt,
        (n, code, data) => {
          if (code === 'error') {
            callback(new Error(data), null);
          } else {
            callback(null, code);
          }
        });
    },
    destroyInternalConnection: function (call, callback) {
      const req = call.request;
      controller.destroyInternalConnection(
        req.id,
        req.direction,
        (n, code, data) => {
          if (code === 'error') {
            callback(new Error(data), null);
          } else {
            callback(null, {message: data});
          }
        });
    },
  };

  return that;
}

exports.createGrpcInterface = createGrpcInterface;
