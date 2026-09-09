// Reproduces Vercel's Node invocation locally: a real http server handing real
// IncomingMessage/ServerResponse objects to the functions' default exports.
// Run: node --experimental-strip-types local-node-test.mts
import http from "node:http";
import mcp from "./api/mcp.ts";

const server = http.createServer((req, res) => {
	void Promise.resolve(mcp(req, res)).catch((error: unknown) => {
		console.error("HANDLER THREW:", error);
		if (!res.headersSent) {
			res.statusCode = 500;
		}
		res.end("handler threw");
	});
});

server.listen(3939, () => {
	console.log("listening on http://127.0.0.1:3939");
});
