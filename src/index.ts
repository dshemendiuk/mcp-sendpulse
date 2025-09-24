import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, InitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// --- SendPulse API & Auth Logic ---

const SENDPULSE_API_BASE = "https://api.sendpulse.com";

const CHANNEL_API_PATHS = {
    whatsapp: "/whatsapp",
    telegram: "/telegram",
    instagram: "/instagram",
    messenger: "/messenger",
    livechat: "/live-chat",
    viber: "/viber/chatbots",
    chatbots: "/chatbots",
};
type Channel = keyof typeof CHANNEL_API_PATHS;

interface Token {
    token: string;
    expiresAt: number;
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
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: apiId, client_secret: apiSecret }),
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

        const expiresIn = (tokenData.expires_in || 3600) * 1000;
        const newToken: Token = {
            token: tokenData.access_token,
            expiresAt: Date.now() + expiresIn - 60000,
        };

        console.log(`[AUTH] Successfully fetched and cached new token for API ID: ${apiId}`);
        tokenCache.set(cacheKey, newToken);
        return newToken;

    } catch (error) {
        console.error("[AUTH] Error fetching OAuth token:", error);
        return null;
    }
}

async function makeSendPulseRequest(channel: Channel, path: string, token: string, options: { method?: 'GET' | 'POST', params?: URLSearchParams, body?: any }) {
    const basePath = CHANNEL_API_PATHS[channel];
    const url = `${SENDPULSE_API_BASE}${basePath}${path}${options.params ? `?${options.params}` : ''}`;
    
    try {
        const response = await fetch(url, {
            method: options.method || 'GET',
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`SendPulse API error! Status: ${response.status}, URL: ${url}, Body: ${errorBody}`);
            return { success: false, error: `API request failed with status ${response.status}`, details: errorBody };
        }
        return await response.json();
    } catch (error) {
        console.error(`Error making SendPulse request to ${url}:`, error);
        return { success: false, error: "An unexpected error occurred." };
    }
}

function createSendPulseServer(authToken: string): McpServer {
    const server = new McpServer({ name: "sendpulse-chatbots", version: "1.2.0" });

    // --- Global Tools ---
    server.tool(
        "get_account_info",
        "Returns information about your current account pricing plan, the number of messages in your plan, bots, contacts, list of tags, and variables",
        {},
        async () => {
            try {
                console.log("[TOOL CALL] Tool: get_account_info");
                const result = await makeSendPulseRequest("chatbots", "/account", authToken, {});
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e: any) {
                console.error("[TOOL ERROR] get_account_info failed:", e);
                return { content: [{ type: "text", text: `Error executing get_account_info: ${e.message}` }] };
            }
        }
    );

    server.tool(
        "get_bots_list",
        "Returns lists of bots with information about each: bot ID, channel information, number of received and unread messages, bot status, and creation date",
        {},
        async () => {
            try {
                console.log("[TOOL CALL] Tool: get_bots_list");
                const result = await makeSendPulseRequest("chatbots", "/bots", authToken, {});
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e: any) {
                console.error("[TOOL ERROR] get_bots_list failed:", e);
                return { content: [{ type: "text", text: `Error executing get_bots_list: ${e.message}` }] };
            }
        }
    );

    server.tool(
        "get_dialogs",
        "Returns information about your dialogs from all channels",
        {
            size: z.number().optional().describe("The limit of pagination items, that will be returned"),
            skip: z.number().optional().describe("The offset of pagination items, where starts a current items batch"),
            //search_after: z.string().optional().describe("Cursor for the next page, obtained from the \'search_after\' field in a previous response. DO NOT guess or invent this value. Omit this for the first page."),
            order: z.enum(["asc", "desc"]).optional().describe("Sort order ASC or DESC"),
        },
        async (args) => {
            try {
                console.log(`[TOOL CALL] Tool: get_dialogs, Arguments: ${JSON.stringify(args)}`);
                const params = new URLSearchParams();
                for (const [key, value] of Object.entries(args)) {
                    if (value !== undefined && value !== null) {
                        params.append(key, String(value));
                    }
                }
                const result = await makeSendPulseRequest("chatbots", "/dialogs", authToken, { params });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e: any) {
                console.error("[TOOL ERROR] get_dialogs failed:", e);
                return { content: [{ type: "text", text: `Error executing get_dialogs: ${e.message}` }] };
            }
        }
    );

    // --- Universal Channel-Based Tools ---
    server.tool(
        "send_message",
        "Sends a text message to a contact on a specific channel.",
        {
            channel: z.enum(["whatsapp", "telegram", "instagram", "messenger", "livechat", "viber"]).describe("The channel to send the message through."),
            contact_id: z.string().describe("The ID of the contact to send the message to."),
            text: z.string().describe("The text content of the message to send."),
        },
        async ({ channel, contact_id, text }) => {
            try {
                console.log(`[TOOL CALL] Tool: send_message, Channel: ${channel}, Contact: ${contact_id}`);
                let requestBody: object;
                switch (channel) {
                    case 'whatsapp':
                        requestBody = { contact_id, message: { type: 'text', text: { body: text } } };
                        break;
                    case 'telegram':
                        requestBody = { contact_id, message: { type: 'text', text: text } };
                        break;
                    case 'instagram':
                        requestBody = { contact_id, messages: [{ type: 'text', message: { text: text } }] };
                        break;
                    case 'messenger':
                        requestBody = { contact_id, message: { type: 'RESPONSE', tag: 'ACCOUNT_UPDATE', content_type: 'message', text: text } };
                        break;
                    case 'livechat':
                    case 'viber':
                        requestBody = { contact_id, messages: [{ type: 'text', text: { text: text } }] };
                        break;
                    default:
                        return { content: [{ type: "text", text: `Error: Channel '${channel}' is not supported.` }] };
                }
                const result = await makeSendPulseRequest(channel, "/contacts/send", authToken, {
                    method: 'POST',
                    body: requestBody,
                });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e: any) {
                console.error("[TOOL ERROR] send_message failed:", e);
                return { content: [{ type: "text", text: `Error executing send_message: ${e.message}` }] };
            }
        }
    );

    return server;
}

// --- Express Server Implementation ---

const app = express();
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/mcp', async (req, res) => {
  console.log(`\n--- New POST /mcp Request ---\nHeaders: ${JSON.stringify(req.headers, null, 2)}\nSession ID Header: ${req.headers['mcp-session-id']}\nRequest Body: ${JSON.stringify(req.body, null, 2)}\n---------------------------\n`);

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId) {
    if (transports[sessionId]) {
        console.log(`[DEBUG] Session check: Found active session for ID: ${sessionId}`);
    } else {
        console.error(`[DEBUG] Session check: ERROR! Request received for an UNKNOWN session ID: ${sessionId}`);
    }
  }

  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    console.log('[INFO] Received initialize request. Creating new session...');
    const initializeRequest = req.body as InitializeRequest;
    let authToken: string | undefined;

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
        if (token) { authToken = token.token; }
    }

    if (!authToken) {
        const bodyAuth = (initializeRequest.params as any)?.authorization as string | undefined;
        if (bodyAuth) {
            authToken = bodyAuth;
            console.log("[AUTH] Using token from request body.");
        }
    }

    if (!authToken) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: Authentication credentials were not provided or are invalid.' }, id: (initializeRequest as any).id });
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
        const sessionId = transport.sessionId;
        console.log(`Session transport closed for ID: ${sessionId}. Scheduling cleanup in 60 seconds.`);
        setTimeout(() => {
            // Check if the session is still the same one and hasn't been replaced by a new one
            if (transports[sessionId] === transport) {
                console.log(`Cleaning up expired session: ${sessionId}`);
                delete transports[sessionId];
            }
        }, 60000); // 60-second grace period
      }
    };
    
    const server = createSendPulseServer(authToken);
    await server.connect(transport);

  } else {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided or invalid request type.' }, id: (req.body as any)?.id || null });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) { res.status(400).send('Invalid or missing session ID'); return; }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

const port = 3000;
const httpServer = app.listen(port, () => {
    console.log(`SendPulse MCP HTTP Server running on http://localhost:${port}/mcp`);
});

httpServer.on('error', (err) => {
    console.error('[SERVER STARTUP ERROR]', err);
    process.exit(1);
});