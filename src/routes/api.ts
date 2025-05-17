// API routes for token subscription and data retrieval
import express from 'express';
import { Request, Response } from 'express';
import WebSocket from 'ws';

export function createApiRouter(binanceClient: any) {
  const router = express.Router();

  // Health check endpoint
  router.get('/health', function(req, res) {
    res.json({
      status: 'ok',
      connections: {
        binance: binanceClient.hasActiveConnections()
      }
    });
  });

  // Route to subscribe to a token and fetch its data
  router.post('/subscribe-token', function(req, res) {
    try {
      const { token } = req.body;
      
      if (!token) {
        res.status(400).json({ error: 'Token is required' });
        return;
      }
      
      console.log(`HTTP request to subscribe to ${token}`);
      
      // Subscribe to the token
      binanceClient.subscribeToSymbol(token);
      
      // Return success response
      res.json({
        status: 'success',
        message: `Subscribed to ${token}`,
        token
      });
    } catch (error) {
      console.error('Error subscribing to token:', error);
      res.status(500).json({ error: 'Failed to subscribe to token' });
    }
  });

  // Route to get all data for a specific token
  router.get('/token-data/:token', function(req, res) {
    try {
      const token = req.params.token;
      
      if (!token) {
        res.status(400).json({ error: 'Token is required' });
        return;
      }
      
      // Check if we're subscribed to this token
      const connections = binanceClient['connections'] as Map<string, WebSocket>;
      const isSubscribed = binanceClient.hasActiveConnections() && 
        Array.from(connections.keys()).includes(token.toLowerCase());
      
      if (!isSubscribed) {
        res.status(404).json({ 
          error: 'Not subscribed to this token',
          message: 'Subscribe to the token first using the /api/subscribe-token endpoint'
        });
        return;
      }
      
      // Get price log data that contains this token
      // This assumes the priceLog contains entries for all tokens
      // We'll filter entries that have this token in their prices
      const priceLog = binanceClient['priceLog'] as Array<{
        matchId: string;
        timestamp: number;
        formattedTime: string;
        prices: Record<string, string>;
        teamOnePerformance?: number;
        teamTwoPerformance?: number;
      }>;
      
      const allLogs = priceLog.filter(entry => 
        entry.prices && entry.prices[token.toLowerCase()] !== undefined
      );
      
      res.json({
        status: 'success',
        token,
        isSubscribed,
        data: allLogs
      });
    } catch (error) {
      console.error('Error fetching token data:', error);
      res.status(500).json({ error: 'Failed to fetch token data' });
    }
  });

  // Route to unsubscribe from a token
  router.delete('/unsubscribe-token/:token', function(req, res) {
    try {
      const token = req.params.token;
      
      if (!token) {
        res.status(400).json({ error: 'Token is required' });
        return;
      }
      
      console.log(`HTTP request to unsubscribe from ${token}`);
      
      // Unsubscribe from the token
      binanceClient.unsubscribeFromSymbol(token);
      
      // Return success response
      res.json({
        status: 'success',
        message: `Unsubscribed from ${token}`,
        token
      });
    } catch (error) {
      console.error('Error unsubscribing from token:', error);
      res.status(500).json({ error: 'Failed to unsubscribe from token' });
    }
  });

  return router;
}
