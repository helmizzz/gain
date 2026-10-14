import { useEffect, useState, useRef } from 'react';
import { SUPPORTED_COINS } from '../data/appData';
import { ExchangeTicker } from '../api/exchangeApi';

export function useBinanceWebSocket(isSandbox: boolean = false) {
  const [tickers, setTickers] = useState<Record<string, ExchangeTicker>>({});
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Collect streams for all supported coins in lowercase
    const streams = SUPPORTED_COINS.map(c => `${c.pair.replace('/', '').toLowerCase()}@ticker`).join('/');
    
    // Official Binance endpoints based on Binance Spot & Demo Mode documentation:
    // Production primary: wss://stream.binance.com:9443 (fallback: wss://data-stream.binance.vision)
    // Testnet primary: wss://stream.testnet.binance.vision (fallback: wss://demo-stream.binance.com)
    const primaryUrl = isSandbox 
      ? `wss://stream.testnet.binance.vision/stream?streams=${streams}`
      : `wss://stream.binance.com:9443/stream?streams=${streams}`;
    const fallbackUrl = isSandbox
      ? `wss://demo-stream.binance.com/stream?streams=${streams}`
      : `wss://data-stream.binance.vision/stream?streams=${streams}`;

    let currentUrl = primaryUrl;
    let isCancelled = false;
    let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const safeCloseSocket = (ws: WebSocket | null, reason = 'closed') => {
      if (!ws) return;
      try {
        if (ws.readyState === WebSocket.CONNECTING) {
          // If socket is still connecting, waiting for open before closing
          // prevents the browser console warning: "WebSocket is closed before the connection is established"
          ws.onopen = () => {
            try { ws.close(1000, reason); } catch {}
          };
          ws.onerror = () => {};
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, reason);
        }
      } catch {
        // Safe no-op
      }
    };

    const connect = () => {
      if (isCancelled) return;
      if (wsRef.current) {
        safeCloseSocket(wsRef.current, 'reconnecting');
        wsRef.current = null;
      }

      try {
        const ws = new WebSocket(currentUrl);
        wsRef.current = ws;

        ws.onmessage = (event) => {
          if (isCancelled) return;
          try {
            const data = JSON.parse(event.data);
            if (data && data.data && data.data.s) {
              const symbol = data.data.s; // e.g., BTCUSDT
              const lastPrice = parseFloat(data.data.c);
              const priceChangePercent = parseFloat(data.data.P);
              
              // Format symbol back to standard pair format (e.g., BTC/USDT)
              const coin = SUPPORTED_COINS.find(c => c.pair.replace('/', '') === symbol);
              if (coin) {
                setTickers(prev => ({
                  ...prev,
                  [coin.pair]: {
                    last: lastPrice,
                    percentage: priceChangePercent,
                    timestamp: Date.now(),
                    source: 'binance-websocket',
                    quoteCurrency: 'USDT'
                  }
                }));
              }
            }
          } catch {
            // Ignore parse errors on malformed frames
          }
        };

        ws.onerror = () => {
          // Switch to fallback endpoint if primary fails
          if (currentUrl === primaryUrl) {
            currentUrl = fallbackUrl;
          }
        };

        ws.onclose = () => {
          if (!isCancelled) {
            reconnectTimeoutId = setTimeout(() => {
              if (!isCancelled) connect();
            }, 5000);
          }
        };
      } catch {
        // If WebSocket construction fails, schedule retry
        if (!isCancelled) {
          reconnectTimeoutId = setTimeout(connect, 5000);
        }
      }
    };

    connect();

    return () => {
      isCancelled = true;
      if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
      }
      if (wsRef.current) {
        safeCloseSocket(wsRef.current, 'component unmounted');
        wsRef.current = null;
      }
    };
  }, [isSandbox]);

  return tickers;
}
