import json
import os
import sys

from cheroot import wsgi
from cheroot.ssl.builtin import BuiltinSSLAdapter
from wsgidav.wsgidav_app import WsgiDAVApp

# Test-only account and loopback-only endpoint, never a user's cloud credentials.
app = WsgiDAVApp({
    "provider_mapping": {"/dav": sys.argv[1]},
    "simple_dc": {"user_mapping": {"*": {"test-user": {"password": "test-password", "roles": []}}}},
    "http_authenticator": {"accept_basic": True, "accept_digest": False, "default_to_digest": False},
    "verbose": 0,
    "logging": {"enable": False},
})
server = wsgi.Server(("127.0.0.1", 0), app)
server.ssl_adapter = BuiltinSSLAdapter(sys.argv[2], sys.argv[3])
server.prepare()
print(json.dumps({"url": "https://127.0.0.1:%d/dav/" % server.socket.getsockname()[1]}), flush=True)
try:
    server.serve()
finally:
    server.stop()
