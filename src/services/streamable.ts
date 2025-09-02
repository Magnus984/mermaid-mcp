import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
import { renderMermaid } from "../utils";
import { FileStorageService } from "./fileStorage";

export const startHTTPStreamableServer = async (
  createServer: (apiKey?: string) => Server,
  endpoint = "/mcp",
  port = 1122,
  eventStore: EventStore = new InMemoryEventStore(),
): Promise<void> => {
  const activeTransports: Record<
    string,
    {
      server: Server;
      transport: StreamableHTTPServerTransport;
    }
  > = {};

  // Define the request handler for streamable-specific logic
  const handleRequest: RequestHandlers["handleRequest"] = async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    if (!req.url) {
      res.writeHead(400).end("No URL");
      return;
    }
    const reqUrl = new URL(req.url, "http://localhost");

    // Non-MCP REST endpoint: POST /render
    if (req.method === "POST" && reqUrl.pathname === "/render") {
      try {
        // Auth: require Authorization Key
        const authHeader = req.headers["authorization"];
        const token =
          authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : undefined;
        if (!token) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(401).end(
            JSON.stringify({ error: { message: "Unauthorized: Missing Authorization Key" } }),
          );
          return;
        }

        // Parse JSON body
        const raw = await getBody(req);
        let body: unknown;
        try {
          body = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400).end(
            JSON.stringify({ error: { message: "Invalid JSON body" } }),
          );
          return;
        }

        // Validate minimal required fields
        const { mermaid, theme = "default", backgroundColor = "white", outputType = "png" } =
          (body as Record<string, unknown>) || {};
        if (typeof mermaid !== "string" || !mermaid.trim()) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400).end(
            JSON.stringify({ error: { message: "'mermaid' is required" } }),
          );
          return;
        }

        // Render
        const { svg, screenshot } = await renderMermaid(
          mermaid as string,
          theme as string,
          backgroundColor as string,
        );

        if (outputType === "mermaid") {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200).end(
            JSON.stringify({ mermaid, mimeType: "text/plain" }),
          );
          return;
        }

        if (outputType === "svg") {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200).end(
            JSON.stringify({ svg, mimeType: "image/svg+xml" }),
          );
          return;
        }

        // png path: store via FileStorageService
        if (!screenshot) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(500).end(
            JSON.stringify({ error: { message: "Failed to generate screenshot" } }),
          );
          return;
        }

        const fileStorage = new FileStorageService(token);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `mermaid-${String(theme)}-${timestamp}.png`;

        const fileResult = await fileStorage.storeFile(
          screenshot,
          filename,
          "image/png",
        );

        res.setHeader("Content-Type", "application/json");
        res.writeHead(200).end(
          JSON.stringify({ url: fileResult.url, fileId: fileResult.fileId, mimeType: "image/png" }),
        );
        return;
      } catch (error) {
        Logger.error("Error handling /render request", error);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(500).end(
          JSON.stringify({ error: { message: "Internal Server Error" } }),
        );
        return;
      }
    }

    // Handle POST requests to endpoint (MCP streamable)
    if (req.method === "POST" && reqUrl.pathname === endpoint) {
      try {
        const sessionId = Array.isArray(req.headers["mcp-session-id"])
          ? req.headers["mcp-session-id"][0]
          : req.headers["mcp-session-id"];
        let transport: StreamableHTTPServerTransport;

        let server: Server;

        const body = await getBody(req);

        /**
         * diagram: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sequence-diagram.
         */
        // 1. If the sessionId is provided and the server is already created, use the existing transport and server.
        if (sessionId && activeTransports[sessionId]) {
          transport = activeTransports[sessionId].transport;
          server = activeTransports[sessionId].server;

          // 2. If the sessionId is not provided and the request is an initialize request, create a new transport for the session.
        } else if (!sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            // use the event store to store the events to replay on reconnect.
            // more details: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#resumability-and-redelivery.
            eventStore: eventStore || new InMemoryEventStore(),
            onsessioninitialized: (_sessionId: string) => {
              // add only when the id Sesison id is generated.
              activeTransports[_sessionId] = {
                server,
                transport,
              };
            },
            sessionIdGenerator: randomUUID,
          });

          // Handle the server close event.
          transport.onclose = async () => {
            const sid = transport.sessionId;
            if (sid && activeTransports[sid]) {
              try {
                await server?.close();
              } catch (error) {
                Logger.error("Error closing server", error);
              }

              // delete used transport and server to avoid memory leak.
              delete activeTransports[sid];
            }
          };

          // Create the server
          const authHeader = req.headers["authorization"];
          const token =
            authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")
              ? authHeader.slice(7)
              : undefined;

          server = createServer(token);

          server.connect(transport);

          await transport.handleRequest(req, res, body);
          return;
        } else {
          // Error if the server is not created but the request is not an initialize request.
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

        // Handle the request if the server is already created.
        await transport.handleRequest(req, res, body);
      } catch (error) {
        Logger.error("Error handling request", error);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(500).end(
          JSON.stringify({
            error: { code: -32603, message: "Internal Server Error" },
            id: null,
            jsonrpc: "2.0",
          }),
        );
      }
      return;
    }

    // Handle GET requests to endpoint
    if (req.method === "GET" && reqUrl.pathname === endpoint) {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const activeTransport:
        | {
            server: Server;
            transport: StreamableHTTPServerTransport;
          }
        | undefined = sessionId ? activeTransports[sessionId] : undefined;

      if (!sessionId) {
        res.writeHead(400).end("No sessionId");
        return;
      }

      if (!activeTransport) {
        res.writeHead(400).end("No active transport");
        return;
      }

      const lastEventId = req.headers["last-event-id"] as string | undefined;
      if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
      } else {
        console.log(`Establishing new streamable connection for session ${sessionId}`);
      }

      await activeTransport.transport.handleRequest(req, res);
      return;
    }

    // Handle DELETE requests to endpoint
    if (req.method === "DELETE" && reqUrl.pathname === endpoint) {
      console.log("received delete request");
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res.writeHead(400).end("Invalid or missing sessionId");
        return;
      }

      console.log("received delete request for session", sessionId);

      const transport = activeTransports[sessionId]?.transport;
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

      return;
    }

    // If we reach here, no handler matched
    res.writeHead(404).end("Not found");
  };

  // Custom cleanup for streamable server
  const cleanup = () => {
    for (const { server, transport } of Object.values(activeTransports)) {
      try {
        transport.close();
      } catch (error) {
        Logger.error("Error closing streamable transport", error);
      }
    }
  };

  // Create the HTTP server using our factory
  createBaseHttpServer(port, endpoint, {
    handleRequest,
    cleanup,
    serverType: "HTTP Streamable Server",
  });
};
