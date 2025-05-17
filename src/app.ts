import WebSocket from 'ws';
import express from 'express';
import http from 'http';
import { EventEmitter } from 'events';
import { createClient } from 'redis';

export interface PriceUpdate {
  symbol: string;
  price: string;
  timestamp: number;
}

export interface MatchInfo {
  id: string;
  teamOne: {
    id: string;
    name: string;
    tokens: string[];
  };
  teamTwo?: {
    id: string;
    name: string;
    tokens: string[];
  };
  isActive: boolean;
}

// Valid authentication tokens
const validTokens = new Set(['btc', 'eth', 'sol']);

class BinanceWebSocketClient extends EventEmitter {
  private connections: Map<string, WebSocket> = new Map();
  private reconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private isActive: boolean = true;
  private activeMatch: MatchInfo | null = null;
  private priceLog: Array<{
    matchId: string;
    timestamp: number;
    formattedTime: string;
    prices: Record<string, string>;
    teamOnePerformance?: number;
    teamTwoPerformance?: number;
  }> = [];
  private redisClient: any = null;
  private streamCount: number = 0;
  private MAX_STREAMS = 1024; // Binance limit per IP

  constructor() {
    super();
    this.initRedis();
  }

  private async initRedis() {
    // Skip Redis initialization unless explicitly enabled
    if (process.env.ENABLE_REDIS === 'true') {
      try {
        this.redisClient = createClient({
          url: process.env.REDIS_URL || 'redis://localhost:6379'
        });
        
        this.redisClient.on('error', (err: any) => {
          console.error('Redis Client Error', err);
        });
        
        await this.redisClient.connect();
        console.log('Redis connected successfully');
      } catch (error) {
        console.error('Failed to initialize Redis:', error);
        // Continue without Redis - fallback to in-memory storage
      }
    } else {
      console.log('Redis disabled - using in-memory storage');
    }
  }

  public subscribeToSymbol(symbol: string): void {
    // Normalize symbol to lowercase
    const normalizedSymbol = symbol.toLowerCase();
    
    // If already connected to this symbol, don't create a new connection
    if (this.connections.has(normalizedSymbol)) {
      return;
    }
    
    // Check if we've reached the stream limit
    if (this.streamCount >= this.MAX_STREAMS) {
      console.error(`Cannot subscribe to ${normalizedSymbol}: Stream limit reached (${this.MAX_STREAMS})`);
      this.emit('error', { symbol: normalizedSymbol, error: 'Stream limit reached' });
      return;
    }
    
    this.connectToSymbol(normalizedSymbol);
  }

  public subscribeToMultipleSymbols(symbols: string[]): void {
    // Normalize all symbols to lowercase
    const normalizedSymbols = symbols.map(s => s.toLowerCase());
    
    // Filter out symbols that are already subscribed
    const newSymbols = normalizedSymbols.filter(s => !this.connections.has(s));
    
    if (newSymbols.length === 0) return;
    
    // Check if adding these would exceed the stream limit
    if (this.streamCount + newSymbols.length > this.MAX_STREAMS) {
      console.error(`Cannot subscribe to ${newSymbols.join(',')}: Would exceed stream limit (${this.MAX_STREAMS})`);
      this.emit('error', { symbols: newSymbols, error: 'Would exceed stream limit' });
      return;
    }
    
    // For multiple symbols, use combined stream
    if (newSymbols.length > 1) {
      this.connectToCombinedStream(newSymbols);
    } else {
      this.connectToSymbol(newSymbols[0]);
    }
  }

  public unsubscribeFromSymbol(symbol: string): void {
    const normalizedSymbol = symbol.toLowerCase();
    
    try {
      // Close the connection if it exists
      if (this.connections.has(normalizedSymbol)) {
        const ws = this.connections.get(normalizedSymbol);
        if (ws && ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }
        this.connections.delete(normalizedSymbol);
        this.streamCount--;
      }

      // Clear any reconnect timeout
      if (this.reconnectTimeouts.has(normalizedSymbol)) {
        clearTimeout(this.reconnectTimeouts.get(normalizedSymbol));
        this.reconnectTimeouts.delete(normalizedSymbol);
      }
    } catch (error) {
      console.log(`Safe unsubscribe from ${symbol}: ${error}`);
    }
  }

  public disconnect(): void {
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
    
    // Reset stream count
    this.streamCount = 0;
    
    // Disconnect Redis
    if (this.redisClient && this.redisClient.isOpen) {
      this.redisClient.quit();
    }
  }
  
  /**
   * Check if there are any active WebSocket connections
   */
  public hasActiveConnections(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Set active match information for logging purposes
   */
  public setActiveMatch(match: MatchInfo | null): void {
    this.activeMatch = match;
    
    if (match) {
      console.log(`WebSocket logging enabled for match: ${match.id}`);
      // Clear previous log if starting a new match
      if (match.isActive) {
        this.priceLog = [];
      }
    } else {
      console.log('WebSocket logging disabled - no active match');
    }
  }
  
  /**
   * Get logged price data for a specific match
   */
  public async getMatchPriceLog(matchId: string): Promise<any[]> {
    // Try to get from Redis first if available
    if (this.redisClient && this.redisClient.isOpen) {
      try {
        const redisKey = `match:${matchId}:pricelog`;
        const data = await this.redisClient.get(redisKey);
        if (data) {
          return JSON.parse(data);
        }
      } catch (error) {
        console.error(`Error retrieving match data from Redis for ${matchId}:`, error);
      }
    }
    
    // Fallback to in-memory data
    return this.priceLog.filter(entry => entry.matchId === matchId);
  }
  
  /**
   * Log current prices with match performance data
   */
  public async logMatchPerformance(teamOnePerformance: number, teamTwoPerformance: number): Promise<void> {
    if (!this.activeMatch || !this.activeMatch.isActive) return;
    
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
      
      // Store in Redis if available
      if (this.redisClient && this.redisClient.isOpen) {
        try {
          const redisKey = `match:${this.activeMatch.id}:pricelog`;
          await this.redisClient.set(redisKey, JSON.stringify(this.priceLog), {
            EX: 86400 // Expire after 24 hours
          });
        } catch (error) {
          console.error(`Error storing match data to Redis for ${this.activeMatch.id}:`, error);
        }
      }
    }
  }

  private connectToSymbol(symbol: string): void {
    // If we already have an active connection for this symbol, don't create a new one
    if (this.connections.has(symbol) && 
        this.connections.get(symbol)?.readyState !== WebSocket.CLOSED && 
        this.connections.get(symbol)?.readyState !== WebSocket.CLOSING) {
      return;
    }
    
    const streamType = "aggTrade"; // Using aggTrade for real-time price updates
    const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@${streamType}`;

    try {
      const ws = new WebSocket(wsUrl);

      // Store the connection immediately to prevent duplicate connections
      this.connections.set(symbol, ws);
      this.streamCount++;

      ws.on('open', () => {
        console.log(`WebSocket connection opened for ${symbol}`);
        this.emit('open', symbol);
      });

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          
          // Extract the price from the aggTrade data
          const update: PriceUpdate = {
            symbol: symbol,
            price: parsed.p, // 'p' is the price field in aggTrade stream
            timestamp: parsed.E // 'E' is the event time
          };
          
          this.handlePriceUpdate(update);
        } catch (error) {
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
        this.streamCount--;
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
    } catch (error) {
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
  
  private connectToCombinedStream(symbols: string[]): void {
    // Create combined stream URL with all symbols
    const streams = symbols.map(s => `${s}@aggTrade`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    
    try {
      const ws = new WebSocket(wsUrl);
      
      // Map to track which symbols this combined stream handles
      symbols.forEach(symbol => {
        this.connections.set(symbol, ws);
      });
      
      this.streamCount += symbols.length;
      
      ws.on('open', () => {
        console.log(`Combined WebSocket connection opened for symbols: ${symbols.join(', ')}`);
        symbols.forEach(symbol => this.emit('open', symbol));
      });
      
      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          
          // Combined streams wrap the data in a stream key
          if (parsed.stream && parsed.data) {
            const streamParts = parsed.stream.split('@');
            if (streamParts.length === 2) {
              const symbol = streamParts[0];
              
              // Extract the price from the aggTrade data
              const update: PriceUpdate = {
                symbol: symbol,
                price: parsed.data.p, // 'p' is the price field in aggTrade stream
                timestamp: parsed.data.E // 'E' is the event time
              };
              console.log("update", update)
              this.handlePriceUpdate(update);
            }
          }
        } catch (error) {
          console.error(`Error parsing combined WebSocket message:`, error);
        }
      });
      
      ws.on('error', (error) => {
        console.error(`Combined WebSocket error for symbols ${symbols.join(', ')}:`, error);
        symbols.forEach(symbol => this.emit('error', { symbol, error }));
      });
      
      ws.on('close', (code, reason) => {
        console.log(`Combined WebSocket connection closed for symbols ${symbols.join(', ')} with code ${code}: ${reason}`);
        
        // Remove all symbol mappings
        symbols.forEach(symbol => {
          this.connections.delete(symbol);
          this.emit('close', symbol);
        });
        
        this.streamCount -= symbols.length;
        
        // Attempt to reconnect if the client is still active and this wasn't a clean close
        if (this.isActive && code !== 1000) {
          const timeout = setTimeout(() => {
            console.log(`Attempting to reconnect combined WebSocket for symbols: ${symbols.join(', ')}`);
            this.connectToCombinedStream(symbols);
          }, 5000); // Reconnect after 5 seconds
          
          // Store timeout with a special key for the combined stream
          this.reconnectTimeouts.set(`combined:${symbols.join(',')}`, timeout);
        }
      });
    } catch (error) {
      console.error(`Error creating combined WebSocket for symbols ${symbols.join(', ')}:`, error);
      
      // Clean up symbol mappings
      symbols.forEach(symbol => {
        this.connections.delete(symbol);
      });
      
      // Attempt to reconnect if the client is still active
      if (this.isActive) {
        const timeout = setTimeout(() => {
          console.log(`Attempting to reconnect combined WebSocket for symbols: ${symbols.join(', ')}`);
          this.connectToCombinedStream(symbols);
        }, 5000); // Reconnect after 5 seconds
        
        // Store timeout with a special key for the combined stream
        this.reconnectTimeouts.set(`combined:${symbols.join(',')}`, timeout);
      }
    }
  }
  
  private handlePriceUpdate(update: PriceUpdate): void {
    // Log price data if there's an active match
    if (this.activeMatch && this.activeMatch.isActive) {
      // Check if this symbol is relevant to the active match
      const allTokens = [
        ...this.activeMatch.teamOne.tokens,
        ...(this.activeMatch.teamTwo?.tokens || [])
      ];
      
      const relevantTokens = allTokens.map(token => {
        const lowerToken = token.toLowerCase();
        return lowerToken.endsWith('usdt') ? lowerToken : `${lowerToken}usdt`;
      });
      
      if (relevantTokens.includes(update.symbol)) {
        // Format timestamp for logging
        const date = new Date(update.timestamp);
        const formattedTime = date.toISOString();
        
        // Check if we already have an entry for this timestamp (within 100ms)
        const existingEntryIndex = this.priceLog.findIndex(
          entry => Math.abs(entry.timestamp - update.timestamp) < 100
        );
        
        if (existingEntryIndex >= 0) {
          // Update existing entry
          this.priceLog[existingEntryIndex].prices[update.symbol] = update.price;
        } else {
          // Create new entry
          this.priceLog.push({
            matchId: this.activeMatch.id,
            timestamp: update.timestamp,
            formattedTime,
            prices: { [update.symbol]: update.price }
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
}

// Create a singleton instance
const binanceClient = new BinanceWebSocketClient();

// Create an Express server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active client connections
const clients = new Set<WebSocket>();

// Handle WebSocket connections from clients
wss.on('connection', (ws, req) => {
  // Client authentication
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  
  if (!token || !validTokens.has(token)) {
    console.log('Unauthorized connection attempt');
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  console.log('Client connected');
  clients.add(ws);

  // Handle messages from clients
  ws.on('message', (message) => {
    console.log("message")
    try {
      const data = JSON.parse(message.toString());
      
      // Handle client commands
      if (data.type === 'subscribe') {
        if (data.symbol) {
          console.log(`Client requested subscription to ${data.symbol}`);
          binanceClient.subscribeToSymbol(data.symbol);
        } else if (data.symbols && Array.isArray(data.symbols)) {
          console.log(`Client requested subscription to multiple symbols: ${data.symbols.join(', ')}`);
          binanceClient.subscribeToMultipleSymbols(data.symbols);
        }
      } else if (data.type === 'unsubscribe') {
        if (data.symbol) {
          console.log(`Client requested unsubscription from ${data.symbol}`);
          binanceClient.unsubscribeFromSymbol(data.symbol);
        }
      } else if (data.type === 'setActiveMatch') {
        console.log(`Client set active match: ${JSON.stringify(data.match)}`);
        binanceClient.setActiveMatch(data.match);
      } else if (data.type === 'logPerformance') {
        binanceClient.logMatchPerformance(data.teamOnePerformance, data.teamTwoPerformance);
      } else if (data.type === 'getMatchPriceLog') {
        binanceClient.getMatchPriceLog(data.matchId).then(log => {
          ws.send(JSON.stringify({
            type: 'matchPriceLog',
            matchId: data.matchId,
            log
          }));
        });
      }
    } catch (error) {
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
binanceClient.on('price', (update: PriceUpdate) => {
  const message = JSON.stringify({
    type: 'price',
    data: update
  });
  
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
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
      binance: binanceClient.hasActiveConnections(),
    }
  });
});

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  binanceClient.disconnect();
  
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, 'Server shutting down');
    }
  });
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
