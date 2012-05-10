#include "PCSocket.h"

#include <cstdlib>
#include <stdio.h>// For atoi()
#include <boost/thread.hpp>

#include "SDPReceiver.h"

class Observer : PCClientObserver {
public:
    Observer(std::string name, SDPReceiver *receiver);
    ~Observer();
    void OnSignedIn();  // Called when we're logged on.
    void OnDisconnected();
    void OnPeerConnected(int id, const std::string& name);
    void OnPeerDisconnected(int peer_id);
    void OnMessageFromPeer(int peer_id, const std::string& message);
    void OnMessageSent(int err);
    void wait();


    static void Replace(std::string& text, const std::string& pattern, const std::string& replace);
    static std::string Match(const std::string& text, const std::string& pattern);

private:
    void init();
    void start();
    void processMessage(int peerid, const std::string& message);


    PC *pc_;
    boost::thread m_Thread;
    std::string name_;
    SDPReceiver *receiver_;
};

