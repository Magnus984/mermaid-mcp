#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  runHTTPStreamableServer,
  runSSEServer,
  runStdioServer,
  runUnifiedServer,
} from "./server";

// Parse command line arguments
const { values } = parseArgs({
  options: {
    transport: {
      type: "string",
      short: "t",
      default: "stdio",
    },
    port: {
      type: "string",
      short: "p",
      default: "3033",
    },
    endpoint: {
      type: "string",
      short: "e",
      default: "", // We'll handle defaults per transport type
    },
    "sse-endpoint": {
      type: "string",
      default: "/sse",
    },
    "streamable-endpoint": {
      type: "string",
      default: "/mcp",
    },
    help: {
      type: "boolean",
      short: "h",
    },
  },
});

// Display help information if requested
if (values.help) {
  console.log(`
MCP Mermaid CLI

Options:
  --transport, -t          Specify the transport protocol: "stdio", "sse", "streamable", or "unified" (default: "stdio")
  --port, -p               Specify the port for HTTP-based transports (default: 3033)
  --endpoint, -e           Specify the endpoint for single transport modes:
                           - For SSE: default is "/sse"
                           - For streamable: default is "/mcp"
  --sse-endpoint           Specify the SSE endpoint for unified mode (default: "/sse")
  --streamable-endpoint    Specify the streamable endpoint for unified mode (default: "/mcp")
  --help, -h               Show this help message

Transport Modes:
  stdio      - Standard input/output (default)
  sse        - Server-Sent Events on HTTP
  streamable - HTTP Streamable transport
  unified    - Both SSE and streamable on the same HTTP server
  `);
  process.exit(0);
}

// Run in the specified transport mode
const transport = values.transport!.toLowerCase();
const port = Number.parseInt(values.port as string, 10);

if (transport === "sse") {
  // Use provided endpoint or default to "/sse" for SSE
  const endpoint = values.endpoint || "/sse";
  runSSEServer(endpoint, port).catch(console.error);
} else if (transport === "streamable") {
  // Use provided endpoint or default to "/mcp" for streamable
  const endpoint = values.endpoint || "/mcp";
  runHTTPStreamableServer(endpoint, port).catch(console.error);
} else if (transport === "unified") {
  // Run both SSE and streamable on the same server
  const sseEndpoint = values["sse-endpoint"] as string;
  const streamableEndpoint = values["streamable-endpoint"] as string;
  
  console.log(`Starting unified MCP server on port ${port}`);
  console.log(`- SSE endpoint: ${sseEndpoint}`);
  console.log(`- Streamable endpoint: ${streamableEndpoint}`);
  
  runUnifiedServer(port, sseEndpoint, streamableEndpoint).catch(console.error);
} else {
  runStdioServer().catch(console.error);
}