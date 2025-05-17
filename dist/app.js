"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server.ts - Node.js WebSocket server for Binance price updates
const ws_1 = __importDefault(require("ws"));
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const events_1 = require("events");
class BinanceWebSocketClient extends events_1.EventEmitter {
    constructor() {
        super();
        this.connections = new Map();
        this.reconnectTimeouts = new Map();
        this.isActive = true;
        this.activeMatch = null;
        this.priceLog = [];
    }
    subscribeToSymbol(symbol) {
        // Normalize symbol to lowercase
        const normalizedSymbol = symbol.toLowerCase();
        // If already connected to this symbol, don't create a new connection
        if (this.connections.has(normalizedSymbol)) {
            return;
        }
        this.connectToSymbol(normalizedSymbol);
    }
    unsubscribeFromSymbol(symbol) {
        const normalizedSymbol = symbol.toLowerCase();
        try {
            // Close the connection if it exists
            if (this.connections.has(normalizedSymbol)) {
                const ws = this.connections.get(normalizedSymbol);
                if (ws && ws.readyState !== ws_1.default.CLOSING && ws.readyState !== ws_1.default.CLOSED) {
                    ws.close();
                }
                this.connections.delete(normalizedSymbol);
            }
            // Clear any reconnect timeout
            if (this.reconnectTimeouts.has(normalizedSymbol)) {
                clearTimeout(this.reconnectTimeouts.get(normalizedSymbol));
                this.reconnectTimeouts.delete(normalizedSymbol);
            }
        }
        catch (error) {
            console.log(`Safe unsubscribe from ${symbol}: ${error}`);
        }
    }
    disconnect() {
        this.isActive = false;
        // Close all connections
        this.connections.forEach((ws, symbol) => {
            ws.close();
            this.connections.delete(symbol);
        });
        // Clear all reconnect timeouts
        this.reconnectTimeouts.forEach((timeout, symbol) => {
            clearTimeout(timeout);
            this.reconnectTimeouts.delete(symbol);
        });
    }
    /**
     * Check if there are any active WebSocket connections
     */
    hasActiveConnections() {
        return this.connections.size > 0;
    }
    /**
     * Set active match information for logging purposes
     */
    setActiveMatch(match) {
        this.activeMatch = match;
        if (match) {
            console.log(`WebSocket logging enabled for match: ${match.id}`);
            // Clear previous log if starting a new match
            if (match.isActive) {
                this.priceLog = [];
            }
        }
        else {
            console.log('WebSocket logging disabled - no active match');
        }
    }
    /**
     * Get logged price data for a specific match
     */
    getMatchPriceLog(matchId) {
        return this.priceLog.filter(entry => entry.matchId === matchId);
    }
    /**
     * Log current prices with match performance data
     */
    logMatchPerformance(teamOnePerformance, teamTwoPerformance) {
        if (!this.activeMatch || !this.activeMatch.isActive)
            return;
        // Find the latest log entry (should be from the same update cycle)
        const latestEntry = this.priceLog[this.priceLog.length - 1];
        if (latestEntry) {
            // Update the latest entry with performance data
            latestEntry.teamOnePerformance = teamOnePerformance;
            latestEntry.teamTwoPerformance = teamTwoPerformance;
            console.log(`Match ${this.activeMatch.id} performance update:`, {
                time: latestEntry.formattedTime,
                teamOne: `${this.activeMatch.teamOne.name}: ${teamOnePerformance.toFixed(4)}%`,
                teamTwo: this.activeMatch.teamTwo ? `${this.activeMatch.teamTwo.name}: ${teamTwoPerformance.toFixed(4)}%` : 'N/A'
            });
        }
    }
    connectToSymbol(symbol) {
        var _a, _b;
        // If we already have an active connection for this symbol, don't create a new one
        if (this.connections.has(symbol) &&
            ((_a = this.connections.get(symbol)) === null || _a === void 0 ? void 0 : _a.readyState) !== ws_1.default.CLOSED &&
            ((_b = this.connections.get(symbol)) === null || _b === void 0 ? void 0 : _b.readyState) !== ws_1.default.CLOSING) {
            return;
        }
        const streamType = "aggTrade"; // Using aggTrade for real-time price updates
        const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@${streamType}`;
        try {
            const ws = new ws_1.default(wsUrl);
            // Store the connection immediately to prevent duplicate connections
            this.connections.set(symbol, ws);
            ws.on('open', () => {
                console.log(`WebSocket connection opened for ${symbol}`);
                this.emit('open', symbol);
            });
            ws.on('message', (data) => {
                var _a;
                try {
                    const parsed = JSON.parse(data.toString());
                    // Extract the price from the aggTrade data
                    const update = {
                        symbol: symbol,
                        price: parsed.p, // 'p' is the price field in aggTrade stream
                        timestamp: parsed.E // 'E' is the event time
                    };
                    console.log("update", update);
                    // Log price data if there's an active match
                    if (this.activeMatch && this.activeMatch.isActive) {
                        // Check if this symbol is relevant to the active match
                        const allTokens = [
                            ...this.activeMatch.teamOne.tokens,
                            ...(((_a = this.activeMatch.teamTwo) === null || _a === void 0 ? void 0 : _a.tokens) || [])
                        ];
                        const relevantTokens = allTokens.map(token => {
                            const lowerToken = token.toLowerCase();
                            return lowerToken.endsWith('usdt') ? lowerToken : `${lowerToken}usdt`;
                        });
                        if (relevantTokens.includes(symbol)) {
                            // Format timestamp for logging
                            const date = new Date(update.timestamp);
                            const formattedTime = date.toISOString();
                            // Check if we already have an entry for this timestamp (within 100ms)
                            const existingEntryIndex = this.priceLog.findIndex(entry => Math.abs(entry.timestamp - update.timestamp) < 100);
                            if (existingEntryIndex >= 0) {
                                // Update existing entry
                                this.priceLog[existingEntryIndex].prices[symbol] = update.price;
                            }
                            else {
                                // Create new entry
                                this.priceLog.push({
                                    matchId: this.activeMatch.id,
                                    timestamp: update.timestamp,
                                    formattedTime,
                                    prices: { [symbol]: update.price }
                                });
                                // Keep log size reasonable (max 1000 entries)
                                if (this.priceLog.length > 1000) {
                                    this.priceLog.shift();
                                }
                            }
                        }
                    }
                    this.emit('price', update);
                }
                catch (error) {
                    console.error(`Error parsing WebSocket message for ${symbol}:`, error);
                }
            });
            ws.on('error', (error) => {
                console.error(`WebSocket error for ${symbol}:`, error);
                this.emit('error', { symbol, error });
            });
            ws.on('close', (code, reason) => {
                console.log(`WebSocket connection closed for ${symbol} with code ${code}: ${reason}`);
                this.connections.delete(symbol);
                this.emit('close', symbol);
                // Attempt to reconnect if the client is still active and this wasn't a clean close
                if (this.isActive && code !== 1000) {
                    const timeout = setTimeout(() => {
                        console.log(`Attempting to reconnect WebSocket for ${symbol}`);
                        this.connectToSymbol(symbol);
                    }, 5000); // Reconnect after 5 seconds
                    this.reconnectTimeouts.set(symbol, timeout);
                }
            });
        }
        catch (error) {
            console.error(`Error creating WebSocket for ${symbol}:`, error);
            this.connections.delete(symbol);
            // Attempt to reconnect if the client is still active
            if (this.isActive) {
                const timeout = setTimeout(() => {
                    console.log(`Attempting to reconnect WebSocket for ${symbol}`);
                    this.connectToSymbol(symbol);
                }, 5000); // Reconnect after 5 seconds
                this.reconnectTimeouts.set(symbol, timeout);
            }
        }
    }
}
// Create a singleton instance
const binanceClient = new BinanceWebSocketClient();
// Create an Express server
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const wss = new ws_1.default.Server({ server });
// Store active client connections
const clients = new Set();
// Handle WebSocket connections from clients
wss.on('connection', (ws) => {
    console.log('Client connected');
    clients.add(ws);
    // Handle messages from clients
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            // Handle client commands
            if (data.type === 'subscribe') {
                if (data.symbol) {
                    console.log(`Client requested subscription to ${data.symbol}`);
                    binanceClient.subscribeToSymbol(data.symbol);
                }
            }
            else if (data.type === 'unsubscribe') {
                if (data.symbol) {
                    console.log(`Client requested unsubscription from ${data.symbol}`);
                    binanceClient.unsubscribeFromSymbol(data.symbol);
                }
            }
            else if (data.type === 'setActiveMatch') {
                console.log(`Client set active match: ${JSON.stringify(data.match)}`);
                binanceClient.setActiveMatch(data.match);
            }
            else if (data.type === 'logPerformance') {
                binanceClient.logMatchPerformance(data.teamOnePerformance, data.teamTwoPerformance);
            }
            else if (data.type === 'getMatchPriceLog') {
                const log = binanceClient.getMatchPriceLog(data.matchId);
                ws.send(JSON.stringify({
                    type: 'matchPriceLog',
                    matchId: data.matchId,
                    log
                }));
            }
        }
        catch (error) {
            console.error('Error handling client message:', error);
        }
    });
    // Handle client disconnection
    ws.on('close', () => {
        console.log('Client disconnected');
        clients.delete(ws);
        // If there are no more clients, consider unsubscribing from all Binance streams
        // This depends on your specific requirements
        if (clients.size === 0) {
            console.log('No more clients connected - keeping Binance connections open');
            // Uncomment the following line if you want to disconnect from Binance when no clients are connected
            // binanceClient.disconnect();
        }
    });
    // Send welcome message to the client
    ws.send(JSON.stringify({
        type: 'info',
        message: 'Connected to Binance WebSocket server'
    }));
});
// Forward Binance price updates to all connected clients
binanceClient.on('price', (update) => {
    const message = JSON.stringify({
        type: 'price',
        data: update
    });
    clients.forEach(client => {
        if (client.readyState === ws_1.default.OPEN) {
            client.send(message);
        }
    });
});
// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
// Optional: Add a simple HTTP endpoint for checking server status
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connections: {
            clients: clients.size,
            binance: binanceClient.hasActiveConnections()
        }
    });
});
// Handle process termination gracefully
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    binanceClient.disconnect();
    clients.forEach(client => {
        if (client.readyState === ws_1.default.OPEN) {
            client.close(1000, 'Server shutting down');
        }
    });
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
//# sourceMappingURL=app.js.map