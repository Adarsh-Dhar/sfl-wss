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
        this.sessionTimer = null;
        this.sessionEndTime = null;
        // Store initial prices for tokens
        this.initialPrices = new Map();
        // Store latest prices for tokens
        this.latestPrices = new Map();
        this.tokenSetA = [];
        this.tokenSetB = [];
        this.trackedTokens = [];
        this.initialTimestamp = null;
        this.priceLog = [];
    }
    subscribeToSymbols(symbols, setATokens, setBTokens) {
        // Reset initial data when subscribing to new set of tokens
        this.initialPrices.clear();
        this.initialTimestamp = null;
        this.tokenSetA = [];
        this.tokenSetB = [];
        this.trackedTokens = [];
        // Normalize symbols to lowercase and add usdt suffix if needed
        const normalizedSymbols = symbols.map(symbol => {
            const normalizedSymbol = symbol.toLowerCase();
            return normalizedSymbol.endsWith('usdt') ? normalizedSymbol : `${normalizedSymbol}usdt`;
        });
        // Store the tracked tokens
        this.trackedTokens = normalizedSymbols;
        // If set A and B are provided, normalize and store them
        if (setATokens && setATokens.length > 0) {
            this.tokenSetA = setATokens.map(symbol => {
                const normalizedSymbol = symbol.toLowerCase();
                return normalizedSymbol.endsWith('usdt') ? normalizedSymbol : `${normalizedSymbol}usdt`;
            });
        }
        if (setBTokens && setBTokens.length > 0) {
            this.tokenSetB = setBTokens.map(symbol => {
                const normalizedSymbol = symbol.toLowerCase();
                return normalizedSymbol.endsWith('usdt') ? normalizedSymbol : `${normalizedSymbol}usdt`;
            });
        }
        // If no specific sets were provided, consider all tokens as set A
        if (this.tokenSetA.length === 0 && this.tokenSetB.length === 0) {
            this.tokenSetA = [...normalizedSymbols];
        }
        // Subscribe to each symbol
        for (const symbol of normalizedSymbols) {
            // If already connected to this symbol, don't create a new connection
            if (this.connections.has(symbol)) {
                continue;
            }
            this.connectToSymbol(symbol);
        }
    }
    subscribeToSymbol(symbol) {
        // Normalize symbol to lowercase
        const normalizedSymbol = symbol.toLowerCase();
        const formattedSymbol = normalizedSymbol.endsWith('usdt') ? normalizedSymbol : `${normalizedSymbol}usdt`;
        // If already connected to this symbol, don't create a new connection
        if (this.connections.has(formattedSymbol)) {
            return;
        }
        this.connectToSymbol(formattedSymbol);
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
        // Clear session timer if exists
        if (this.sessionTimer) {
            clearTimeout(this.sessionTimer);
            this.sessionTimer = null;
            this.sessionEndTime = null;
        }
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
                    // Process the price update for percentage tracking
                    this.processPriceUpdate(update);
                    // Log price data if there's an active match (keeping this for compatibility)
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
                    // Emit the original price update for backward compatibility
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
    /**
     * Process a price update and track percentage changes
     */
    processPriceUpdate(update) {
        // If this token is not in our tracked list, ignore it
        if (!this.trackedTokens.includes(update.symbol)) {
            return;
        }
        // Always store the latest price
        this.latestPrices.set(update.symbol, {
            price: update.price,
            timestamp: update.timestamp
        });
        // If we don't have an initial timestamp yet, check if we should set one
        if (this.initialTimestamp === null) {
            // Store this as the first price for this token
            this.initialPrices.set(update.symbol, {
                price: update.price,
                timestamp: update.timestamp
            });
            // If we have initial prices for all tracked tokens with the same timestamp (within 1 second)
            // then set this as our initial timestamp
            if (this.trackedTokens.every(token => this.initialPrices.has(token))) {
                const timestamps = Array.from(this.initialPrices.values()).map(data => data.timestamp);
                const minTimestamp = Math.min(...timestamps);
                const maxTimestamp = Math.max(...timestamps);
                // Check if all timestamps are within 1 second of each other
                if (maxTimestamp - minTimestamp < 1000) {
                    this.initialTimestamp = minTimestamp;
                    console.log(`Initial timestamp set to ${this.initialTimestamp} with prices:`, Object.fromEntries(this.initialPrices.entries()));
                }
            }
            return;
        }
        // If we have an initial timestamp, calculate percentage change
        const initialData = this.initialPrices.get(update.symbol);
        if (initialData) {
            const initialPrice = parseFloat(initialData.price);
            const currentPrice = parseFloat(update.price);
            const percentageChange = ((currentPrice - initialPrice) / initialPrice) * 100;
            // Create percentage update object
            const percentageUpdate = {
                symbol: update.symbol,
                currentPrice: update.price,
                initialPrice: initialData.price,
                percentageChange: parseFloat(percentageChange.toFixed(4)),
                timestamp: update.timestamp
            };
            // Emit the percentage update
            this.emit('percentage', percentageUpdate);
            // If all tracked tokens have updates, emit a combined update
            const { updates: allTokenUpdates, averageA, averageB } = this.getAllTokenPercentages();
            if (allTokenUpdates.length === this.trackedTokens.length) {
                // Calculate the overall average percentage change
                const totalPercentageChange = allTokenUpdates.reduce((sum, token) => sum + token.percentageChange, 0);
                const averagePercentageChange = totalPercentageChange / allTokenUpdates.length;
                this.emit('allTokensUpdate', {
                    tokens: allTokenUpdates,
                    timestamp: update.timestamp,
                    initialTime: this.initialTimestamp,
                    averagePercentageChange: parseFloat(averagePercentageChange.toFixed(4)),
                    averageA,
                    averageB
                });
            }
        }
    }
    /**
     * Get the latest percentage updates for all tracked tokens
     * @returns An object containing all token updates and separate averages for set A and set B
     */
    getAllTokenPercentages() {
        if (this.initialTimestamp === null) {
            return { updates: [], averageA: null, averageB: 0 };
        }
        const updates = [];
        const setAUpdates = [];
        const setBUpdates = [];
        for (const symbol of this.trackedTokens) {
            const initialData = this.initialPrices.get(symbol);
            const latestData = this.latestPrices.get(symbol);
            if (!initialData || !latestData)
                continue;
            // Calculate the percentage change
            const initialPrice = parseFloat(initialData.price);
            const currentPrice = parseFloat(latestData.price);
            const percentageChange = ((currentPrice - initialPrice) / initialPrice) * 100;
            const update = {
                symbol,
                currentPrice: latestData.price,
                initialPrice: initialData.price,
                percentageChange: parseFloat(percentageChange.toFixed(4)),
                timestamp: latestData.timestamp
            };
            updates.push(update);
            // Add to the appropriate set
            if (this.tokenSetA.includes(symbol)) {
                setAUpdates.push(update);
            }
            if (this.tokenSetB.includes(symbol)) {
                setBUpdates.push(update);
            }
        }
        // Calculate averages for each set
        let averageA = null;
        // Initialize averageB to 0 instead of null
        let averageB = 0;
        if (setAUpdates.length > 0) {
            const totalA = setAUpdates.reduce((sum, token) => sum + token.percentageChange, 0);
            averageA = parseFloat((totalA / setAUpdates.length).toFixed(4));
        }
        if (setBUpdates.length > 0) {
            const totalB = setBUpdates.reduce((sum, token) => sum + token.percentageChange, 0);
            averageB = parseFloat((totalB / setBUpdates.length).toFixed(4));
        }
        return { updates, averageA, averageB };
    }
    /**
     * Reset the tracking of initial prices and percentages
     */
    resetTracking() {
        this.initialPrices.clear();
        this.latestPrices.clear();
        this.initialTimestamp = null;
    }
    /**
     * Start a timed session that will automatically end after the specified duration
     * @param durationMs Duration in milliseconds
     * @param callback Optional callback to execute when the session ends
     */
    startTimedSession(durationMs, callback) {
        // Clear any existing timer
        if (this.sessionTimer) {
            clearTimeout(this.sessionTimer);
        }
        // Reset tracking to start fresh
        this.resetTracking();
        // Set the end time
        this.sessionEndTime = Date.now() + durationMs;
        // Create a new timer
        this.sessionTimer = setTimeout(() => {
            // Get final results
            const finalResults = this.getFinalResults();
            // Emit the final results
            this.emit('sessionEnd', finalResults);
            // Execute callback if provided
            if (callback) {
                callback();
            }
            // Clear the timer reference
            this.sessionTimer = null;
            this.sessionEndTime = null;
        }, durationMs);
        console.log(`Started timed session for ${durationMs / 1000} seconds`);
    }
    /**
     * Start a continuous session that doesn't automatically end
     */
    startFixedSession() {
        // Reset tracking to start fresh
        this.resetTracking();
        console.log('Started continuous session. Server will keep running until manually stopped.');
    }
    /**
     * Get the remaining time in the current session (in milliseconds)
     */
    getRemainingSessionTime() {
        if (!this.sessionEndTime) {
            return null;
        }
        const remainingTime = this.sessionEndTime - Date.now();
        return remainingTime > 0 ? remainingTime : 0;
    }
    /**
     * Get the final results of the current tracking session
     */
    getFinalResults() {
        const { updates, averageA, averageB } = this.getAllTokenPercentages();
        // Calculate the overall average percentage change
        const totalPercentageChange = updates.reduce((sum, token) => sum + token.percentageChange, 0);
        const averagePercentageChange = updates.length > 0 ?
            parseFloat((totalPercentageChange / updates.length).toFixed(4)) : 0;
        return {
            tokens: updates,
            timestamp: Date.now(),
            averagePercentageChange,
            averageA,
            averageB,
            isFinalResult: true
        };
    }
}
// Create a singleton instance
const binanceClient = new BinanceWebSocketClient();
// Create an Express server
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const wss = new ws_1.default.Server({ server });
// Serve static files from the public directory
app.use(express_1.default.static('public'));
const clients = new Map();
// Handle WebSocket connections from clients
wss.on('connection', (ws) => {
    const connectionTime = Date.now();
    console.log('Client connected at', new Date(connectionTime).toISOString());
    clients.set(ws, { ws, connectedAt: connectionTime });
    // Automatically start a 60-second session when a client connects
    binanceClient.startFixedSession();
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            // Handle client commands
            if (data.type === 'subscribeToTokens') {
                // Validate the request
                if (!data.tokens || !Array.isArray(data.tokens)) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid tokens data. Expected an array of token symbols.'
                    }));
                    return;
                }
                // Check for token sets A and B
                const setATokens = data.setATokens && Array.isArray(data.setATokens) ? data.setATokens : [];
                const setBTokens = data.setBTokens && Array.isArray(data.setBTokens) ? data.setBTokens : [];
                // Subscribe to the tokens with set information
                binanceClient.subscribeToSymbols(data.tokens, setATokens, setBTokens);
            }
            else if (data.type === 'subscribe') {
                if (data.symbol) {
                    console.log(`Client requested subscription to ${data.symbol}`);
                    binanceClient.subscribeToSymbol(data.symbol);
                }
                else if (data.symbols && Array.isArray(data.symbols)) {
                    console.log(`Client requested subscription to multiple symbols: ${data.symbols.join(', ')}`);
                    binanceClient.subscribeToSymbols(data.symbols);
                }
            }
            else if (data.type === 'unsubscribe') {
                if (data.symbol) {
                    console.log(`Client requested unsubscription from ${data.symbol}`);
                    binanceClient.unsubscribeFromSymbol(data.symbol);
                }
            }
            else if (data.type === 'resetTracking') {
                console.log('Client requested to reset price tracking');
                binanceClient.resetTracking();
            }
            else if (data.type === 'startTimedSession') {
                // Validate the request
                if (typeof data.duration !== 'number' || data.duration <= 0) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid duration. Expected a positive number in seconds.'
                    }));
                    return;
                }
                const durationMs = data.duration * 1000; // Convert seconds to milliseconds
                console.log(`Client requested to start a timed session for ${data.duration} seconds`);
                // Start the timed session
                binanceClient.startTimedSession(durationMs);
                ws.send(JSON.stringify({
                    type: 'sessionStarted',
                    duration: data.duration,
                    startTime: Date.now()
                }));
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
                const currentTime = Date.now();
                const clientInfo = clients.get(ws);
                if (clientInfo) {
                    const connectionDuration = currentTime - clientInfo.connectedAt;
                    const durationInSeconds = (connectionDuration / 1000).toFixed(2);
                    ws.send(JSON.stringify({
                        type: 'matchPriceLog',
                        matchId: data.matchId,
                        log,
                        connectionDuration: connectionDuration,
                        connectionTime: `${durationInSeconds} seconds`
                    }));
                }
                else {
                    ws.send(JSON.stringify({
                        type: 'matchPriceLog',
                        matchId: data.matchId,
                        log
                    }));
                }
            }
            else if (data.type === 'getAllTokenPercentages') {
                const { updates: percentages, averageA, averageB } = binanceClient.getAllTokenPercentages();
                const currentTime = Date.now();
                const clientInfo = clients.get(ws);
                if (clientInfo) {
                    const connectionDuration = currentTime - clientInfo.connectedAt;
                    const durationInSeconds = (connectionDuration / 1000).toFixed(2);
                    ws.send(JSON.stringify({
                        type: 'allTokenPercentages',
                        data: percentages,
                        averageA,
                        averageB,
                        connectionDuration: connectionDuration,
                        connectionTime: `${durationInSeconds} seconds`
                    }));
                }
                else {
                    ws.send(JSON.stringify({
                        type: 'allTokenPercentages',
                        data: percentages,
                        averageA,
                        averageB
                    }));
                }
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
    // Send welcome message to the client with connection timestamp
    ws.send(JSON.stringify({
        type: 'info',
        message: 'Connected to Binance WebSocket server',
        connectedAt: connectionTime,
        connectionTime: new Date(connectionTime).toISOString()
    }));
});
// Forward Binance price updates to all connected clients
binanceClient.on('price', (update) => {
    const currentTime = Date.now();
    clients.forEach((clientInfo, clientWs) => {
        if (clientWs.readyState === ws_1.default.OPEN) {
            const connectionDuration = currentTime - clientInfo.connectedAt;
            const durationInSeconds = (connectionDuration / 1000).toFixed(2);
            const message = JSON.stringify({
                type: 'price',
                data: update,
                connectionDuration: connectionDuration,
                connectionTime: `${durationInSeconds} seconds`
            });
            clientWs.send(message);
        }
    });
});
// Forward percentage updates to all connected clients
binanceClient.on('percentage', (update) => {
    const currentTime = Date.now();
    clients.forEach((clientInfo, clientWs) => {
        if (clientWs.readyState === ws_1.default.OPEN) {
            const connectionDuration = currentTime - clientInfo.connectedAt;
            const durationInSeconds = (connectionDuration / 1000).toFixed(2);
            const message = JSON.stringify({
                type: 'percentage',
                data: update,
                connectionDuration: connectionDuration,
                connectionTime: `${durationInSeconds} seconds`
            });
            clientWs.send(message);
        }
    });
});
// Forward combined token updates to all connected clients
binanceClient.on('allTokensUpdate', (update) => {
    const currentTime = Date.now();
    clients.forEach((clientInfo, clientWs) => {
        if (clientWs.readyState === ws_1.default.OPEN) {
            const connectionDuration = currentTime - clientInfo.connectedAt;
            const durationInSeconds = (connectionDuration / 1000).toFixed(2);
            const message = JSON.stringify({
                type: 'allTokensUpdate',
                data: update,
                connectionDuration: connectionDuration,
                connectionTime: `${durationInSeconds} seconds`
            });
            clientWs.send(message);
        }
    });
});
// Handle session end events
binanceClient.on('sessionEnd', (finalResults) => {
    console.log('Timed session ended, sending final results to all clients');
    // Display the final score
    console.log('FINAL SCORE:');
    console.log('====================');
    console.log(`Overall Average: ${finalResults.averagePercentageChange.toFixed(4)}%`);
    if (finalResults.averageA !== undefined && finalResults.averageA !== null) {
        console.log(`Team A Average: ${finalResults.averageA.toFixed(4)}%`);
    }
    if (finalResults.averageB !== undefined && finalResults.averageB !== null) {
        console.log(`Team B Average: ${finalResults.averageB.toFixed(4)}%`);
    }
    console.log('====================');
    clients.forEach((clientInfo, clientWs) => {
        if (clientWs.readyState === ws_1.default.OPEN) {
            const message = JSON.stringify({
                type: 'sessionEnd',
                finalResults: finalResults
            });
            clientWs.send(message);
            // Keep connections open instead of closing them
            console.log('Sent final results to client, keeping connection open.');
        }
    });
    // Keep the server running instead of shutting down
    console.log('Session ended, but server will continue running. New clients can still connect.');
});
// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
// Enable JSON parsing for request bodies
app.use(express_1.default.json());
// Import API routes from the routes directory
const api_1 = require("./routes/api");
// Use the API router for /api routes
app.use('/api', (0, api_1.createApiRouter)(binanceClient));
// Simple health check endpoint directly on the app
app.get('/health', function (req, res) {
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
    clients.forEach((clientInfo, clientWs) => {
        if (clientWs.readyState === ws_1.default.OPEN) {
            clientWs.close(1000, 'Server shutting down');
        }
    });
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
//# sourceMappingURL=app.js.map