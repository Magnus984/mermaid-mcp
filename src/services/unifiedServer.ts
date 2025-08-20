// services/unifiedServer.ts
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  type EventStore,
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  InMemoryEventStore,
  type RequestHandlers,
  createBaseHttpServer,
  getBody,
} from "../utils";
import { Logger } from "../utils/logger";

interface UnifiedServerOptions {
  sseEndpoint?: string;
  streamableEndpoint?: string;
  port?: number;
  eventStore?: EventStore;
}

export const startUnifiedMcpServer = async (
  createServer: () => Server,
  options: UnifiedServerOptions = {},
): Promise<void> => {
  const {
    sseEndpoint = "/sse",
    streamableEndpoint = "/mcp",
    port = 3033,
    eventStore = new InMemoryEventStore(),
  } = options;

  // Active transports for streamable connections
  const activeStreamableTransports: Record<
    string,
    {
      server: Server;
      transport: StreamableHTTPServerTransport;
    }
  > = {};

  // Active transports for SSE connections
  const activeSSETransports: Record<string, SSEServerTransport> = {};

  const handleRequest: RequestHandlers["handleRequest"] = async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    if (!req.url) {
      res.writeHead(400).end("No URL");
      return;
    }

    const reqUrl = new URL(req.url, "http://localhost");
    console.log(`[Unified Server] ${req.method} ${reqUrl.pathname}`);

    // Handle SSE requests
    if (handleSSERequests(req, res, reqUrl, createServer)) {
      console.log(`[Unified Server] Handled by SSE handler`);
      return;
    }
    
    // Handle Streamable requests
    if (await handleStreamableRequests(req, res, reqUrl, createServer)) {
      console.log(`[Unified Server] Handled by Streamable handler`);
      return;
    }

    // If we reach here, no handler matched
    console.log(`[Unified Server] No handler matched for ${req.method} ${reqUrl.pathname}`);
    res.writeHead(404).end("Not found");
  };

  // SSE request handler
  const handleSSERequests = (
    req: IncomingMessage,
    res: ServerResponse,
    reqUrl: URL,
    createServer: () => Server,
  ): boolean => {
    // Handle GET requests to the SSE endpoint
    if (req.method === "GET" && reqUrl.pathname === sseEndpoint) {
      console.log(`[SSE Handler] Handling GET ${sseEndpoint}`);
      handleSSEConnection(req, res, createServer);
      return true;
    }

    // Handle POST requests to the messages endpoint for SSE
    if (req.method === "POST" && req.url?.startsWith("/messages")) {
      console.log(`[SSE Handler] Handling POST /messages`);
      handleSSEPostMessage(req, res);
      return true;
    }

    return false;
  };

  // Streamable request handler
  const handleStreamableRequests = async (
    req: IncomingMessage,
    res: ServerResponse,
    reqUrl: URL,
    createServer: () => Server,
  ): Promise<boolean> => {
    // Handle POST requests to streamable endpoint
    if (req.method === "POST" && reqUrl.pathname === streamableEndpoint) {
      console.log(`[Streamable Handler] Handling POST ${streamableEndpoint}`);
      await handleStreamablePost(req, res, createServer);
      return true;
    }

    // Handle GET requests to streamable endpoint
    if (req.method === "GET" && reqUrl.pathname === streamableEndpoint) {
      console.log(`[Streamable Handler] Handling GET ${streamableEndpoint}`);
      await handleStreamableGet(req, res);
      return true;
    }

    // Handle DELETE requests to streamable endpoint
    if (req.method === "DELETE" && reqUrl.pathname === streamableEndpoint) {
      console.log(`[Streamable Handler] Handling DELETE ${streamableEndpoint}`);
      await handleStreamableDelete(req, res);
      return true;
    }

    return false;
  };

  // SSE Connection Handler
  const handleSSEConnection = async (
    req: IncomingMessage,
    res: ServerResponse,
    createServer: () => Server,
  ) => {
    const server = createServer();
    const transport = new SSEServerTransport("/messages", res);

    activeSSETransports[transport.sessionId] = transport;

    let closed = false;

    res.on("close", async () => {
      closed = true;

      try {
        await server.close();
      } catch (error) {
        Logger.error("Error closing SSE server", error);
      }

      delete activeSSETransports[transport.sessionId];
    });

    try {
      await server.connect(transport);

      await transport.send({
        jsonrpc: "2.0",
        method: "sse/connection",
        params: { message: "SSE Connection established" },
      });
    } catch (error) {
      if (!closed) {
        Logger.error("Error connecting to SSE server", error);
        res.writeHead(500).end("Error connecting to server");
      }
    }
  };

  // SSE Post Message Handler
  const handleSSEPostMessage = async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const sessionId = new URL(
      req.url!,
      "https://example.com",
    ).searchParams.get("sessionId");

    if (!sessionId) {
      res.writeHead(400).end("No sessionId");
      return;
    }

    const activeTransport = activeSSETransports[sessionId];

    if (!activeTransport) {
      res.writeHead(400).end("No active transport");
      return;
    }

    await activeTransport.handlePostMessage(req, res);
  };

  // Streamable POST Handler
  const handleStreamablePost = async (
    req: IncomingMessage,
    res: ServerResponse,
    createServer: () => Server,
  ) => {
    try {
      const sessionId = Array.isArray(req.headers["mcp-session-id"])
        ? req.headers["mcp-session-id"][0]
        : req.headers["mcp-session-id"];
      
      let transport: StreamableHTTPServerTransport;
      let server: Server;
      const body = await getBody(req);

      // If sessionId exists and transport is active, use existing
      if (sessionId && activeStreamableTransports[sessionId]) {
        transport = activeStreamableTransports[sessionId].transport;
        server = activeStreamableTransports[sessionId].server;
      }
      // If no sessionId but is initialize request, create new
      else if (!sessionId && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          eventStore: eventStore,
          onsessioninitialized: (_sessionId: string) => {
            activeStreamableTransports[_sessionId] = {
              server,
              transport,
            };
          },
          sessionIdGenerator: randomUUID,
        });

        transport.onclose = async () => {
          const sid = transport.sessionId;
          if (sid && activeStreamableTransports[sid]) {
            try {
              await server?.close();
            } catch (error) {
              Logger.error("Error closing streamable server", error);
            }
            delete activeStreamableTransports[sid];
          }
        };

        try {
          server = createServer();
        } catch (error) {
          if (error instanceof Response) {
            res.writeHead(error.status).end(error.statusText);
            return;
          }
          res.writeHead(500).end("Error creating server");
          return;
        }

        server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      } else {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400).end(
          JSON.stringify({
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
            jsonrpc: "2.0",
          }),
        );
        return;
      }

      await transport.handleRequest(req, res, body);
    } catch (error) {
      Logger.error("Error handling streamable request", error);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(500).end(
        JSON.stringify({
          error: { code: -32603, message: "Internal Server Error" },
          id: null,
          jsonrpc: "2.0",
        }),
      );
    }
  };

  // Streamable GET Handler
  const handleStreamableGet = async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      res.writeHead(400).end("No sessionId");
      return;
    }

    const activeTransport = activeStreamableTransports[sessionId];

    if (!activeTransport) {
      res.writeHead(400).end("No active transport");
      return;
    }

    const lastEventId = req.headers["last-event-id"] as string | undefined;
    if (lastEventId) {
      console.log(`Streamable client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
      console.log(`Establishing new streamable connection for session ${sessionId}`);
    }

    await activeTransport.transport.handleRequest(req, res);
  };

  // Streamable DELETE Handler
  const handleStreamableDelete = async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    
    if (!sessionId) {
      res.writeHead(400).end("Invalid or missing sessionId");
      return;
    }

    const transport = activeStreamableTransports[sessionId]?.transport;
    if (!transport) {
      res.writeHead(400).end("No active transport");
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling delete request:", error);
      res.writeHead(500).end("Error handling delete request");
    }
  };

  // Cleanup function
  const cleanup = () => {
    // Close all SSE transports
    for (const transport of Object.values(activeSSETransports)) {
      try {
        transport.close();
      } catch (error) {
        Logger.error("Error closing SSE transport", error);
      }
    }

    // Close all streamable transports
    for (const { transport } of Object.values(activeStreamableTransports)) {
      try {
        transport.close();
      } catch (error) {
        Logger.error("Error closing streamable transport", error);
      }
    }
  };

  // Create the unified HTTP server
  createBaseHttpServer(port, "unified", {
    handleRequest,
    cleanup,
    serverType: "Unified MCP Server",
  });
};