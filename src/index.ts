
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, InitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// --- SendPulse API & Auth Logic ---

const SENDPULSE_API_BASE = "https://api.sendpulse.com";

interface Token {
    token: string;
    expiresAt: number; // Timestamp in milliseconds
}

const tokenCache = new Map<string, Token>();

async function getSendPulseOAuthToken(apiId: string, apiSecret: string): Promise<Token | null> {
    const cacheKey = apiId;

    const cachedToken = tokenCache.get(cacheKey);
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
        console.log(`[AUTH] Using cached token for API ID: ${apiId}`);
        return cachedToken;
    }

    console.log(`[AUTH] No valid cached token. Fetching new token for API ID: ${apiId}`);
    try {
        const response = await fetch(`${SENDPULSE_API_BASE}/oauth/access_token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: apiId,
                client_secret: apiSecret,
            }),
        });

        if (!response.ok) {
            console.error(`[AUTH] Failed to fetch token. Status: ${response.status}, Body: ${await response.text()}`);
            return null;
        }

        const tokenData = await response.json();
        if (!tokenData.access_token) {
            console.error("[AUTH] Fetched token data is invalid. No access_token found.");
            return null;
        }

        const expiresIn = (tokenData.expires_in || 3600) * 1000; // Convert to milliseconds
        const newToken: Token = {
            token: tokenData.access_token,
            expiresAt: Date.now() + expiresIn - 60000, // Subtract 1 minute buffer
        };

        console.log(`[AUTH] Successfully fetched and cached new token for API ID: ${apiId}`);
        tokenCache.set(cacheKey, newToken);
        return newToken;

    } catch (error) {
        console.error("[AUTH] Error fetching OAuth token:", error);
        return null;
    }
}

async function makeSendPulseRequest(path: string, token: string, params?: URLSearchParams) {
  const url = `${SENDPULSE_API_BASE}/chatbots${path}${params ? `?${params}` : ''}`;
  try {
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      console.error(`SendPulse API error! Status: ${response.status}, Body: ${await response.text()}` );
      return { success: false, error: `API request failed with status ${response.status}` };
    }
    return await response.json();
  } catch (error) {
    console.error("Error making SendPulse request:", error);
    return { success: false, error: "An unexpected error occurred." };
  }
}

function createSendPulseServer(authToken: string): McpServer {
    const server = new McpServer({
        name: "sendpulse-chatbots",
        version: "1.0.0",
    });

    server.tool("get_account_info", "Returns account info", {}, async () => {
        console.log("[TOOL CALL] Tool: get_account_info");
        const result = await makeSendPulseRequest("/account", authToken);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    server.tool("get_bots_list", "Returns a list of bots", {}, async () => {
        console.log("[TOOL CALL] Tool: get_bots_list");
        const result = await makeSendPulseRequest("/bots", authToken);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    server.tool("get_dialogs", "Returns a list of dialogs", {
        size: z.number().optional(), skip: z.number().optional(),
        search_after: z.string().optional(), order: z.enum(["asc", "desc"]).optional(),
    }, async (args) => {
        console.log(`[TOOL CALL] Tool: get_dialogs, Arguments: ${JSON.stringify(args)}`);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(args)) {
            if (value !== undefined && value !== null) {
                params.append(key, String(value));
            }
        }
        const result = await makeSendPulseRequest("/dialogs", authToken, params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    return server;
}

// --- Express Server Implementation ---

const app = express();
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    
    const initializeRequest = req.body as InitializeRequest;
    let authToken: string | undefined;

    // --- AUTH LOGIC ---
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        authToken = authHeader.substring(7);
        console.log("[AUTH] Using direct Bearer token.");
    }

    const apiId = req.headers['x-sp-id'] as string | undefined;
    const apiSecret = req.headers['x-sp-secret'] as string | undefined;
    if (!authToken && apiId && apiSecret) {
        console.log(`[AUTH] Attempting to authorize with API ID/Secret for: ${apiId}`);
        const token = await getSendPulseOAuthToken(apiId, apiSecret);
        if (token) {
            authToken = token.token;
        }
    }

    if (!authToken) {
        const bodyAuth = (initializeRequest.params as any)?.authorization as string | undefined;
        if (bodyAuth) {
            authToken = bodyAuth;
            console.log("[AUTH] Using token from request body.");
        }
    }

    if (!authToken) {
        res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized: Authentication credentials were not provided or are invalid.' },
            id: (initializeRequest as any).id,
        });
        return;
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports[newSessionId] = transport;
        console.log(`Session initialized: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };
    
    const server = createSendPulseServer(authToken);
    await server.connect(transport);

  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided or invalid request type.' },
      id: (req.body as any)?.id || null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

const port = 3000;
app.listen(port, () => {
    console.log(`SendPulse MCP HTTP Server running on http://localhost:${port}/mcp`);
});
