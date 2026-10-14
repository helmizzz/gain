import { lazy,

 Suspense, useState, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import {
  NavigationRoute,
  ExchangeName,
  TradingPosition,
  TransactionRecord,
  TradeRecord,
  ExecutedLayerDetail,
  UserWallet,
  ConnectedExchangeConfig,
  BotMode,
  AveragingStep,
  PriceAlert,
} from './types';
import { initialPositions, initialTransactions, initialWallet, SUPPORTED_COINS } from './data/appData';
import { HeaderBar } from './components/HeaderBar';
import { BottomDock } from './components/BottomDock';
import { generateDefaultLayersForPosition } from './utils/tradingPositionUtils';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { LanguageProvider } from './context/LanguageContext';
import { RoleRoute } from './components/routing/ProtectedRoute';
import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import {
  loadExchangePortfolio as fetchExchangePortfolio,
  loadExchangeTrades as fetchExchangeTrades,
  executeExchangeOrder as placeExchangeOrder,
  loadTickerBatch,
  LIVE_TICKER_SYMBOLS,
  type BatchTickerResponse,
} from './services/exchangeService';
import { removeBotRunner as deleteBackgroundBot, registerBotRunner as registerBackgroundBot } from './services/botService';
import { disconnectBotExchange, storeBotCredentials, getBotEngineStatus, reconcileBot,
  rebuildBotPositionFromFills, setBotStatus, pauseAllBots, forceTakeProfit } from './api/botApi';
import { activateWalletAccount as processWalletActivation } from './services/walletService';
import { queryClient } from './queryClient';
import { getUserTransactions } from './api/walletApi';
import { useUiStore } from './stores/uiStore';
import { reportClientEvent } from './services/observabilityService';
import { formatUsdt } from './utils/formatters';
import { decorateTradesWithRealizedPnl } from './utils/tradeMetrics';
import { assertProductionSafeMode, isDemoMode } from './config/appMode';
import { validateFinancialAction } from './utils/serverValidation';
import { postJson } from './api/httpClient';
import { getLicenseTierConfig } from './config/licensePromo';
import { useBinanceWebSocket } from './hooks/useBinanceWebSocket';
import { normalizeBotMode } from './utils/botModeLabels';
import { normalizeBotRuntimeState, type BotRuntimeState } from './utils/botRuntimePositions';
import { filterExchangeScoped, normalizeExchangeName } from './utils/exchangeIsolation';
import { getExchangeDescriptor } from './config/exchangeRegistry';
import {
  createSnapshotGateState,
  decidePortfolioSnapshot,
  nextRequestSequence,
  snapshotKey,
  mergeServerWalletMetadataPreservingLiveExchange,
  type PortfolioSnapshotCandidate,
} from './utils/exchangePortfolioSnapshot';

import {
  subscribeToUserWallet,
  subscribeToUserPositions,
  subscribeToUserTransactions,
  fetchOlderUserTransactions,
  updateUserWallet,
  deletePositionFromFirestore,
  setActiveExchangeInFirestore,
  disconnectSingleExchangeFromFirestore,
  disconnectExchangeFromFirestore,
} from './repositories/userRepository';
import type { FirestorePageCursor } from './repositories/userRepository';

import { subscribeToPriceAlerts, checkPriceAlerts } from './services/priceAlertService';
import {
  NotificationToastContainer,
  AppNotification,
} from './components/common/NotificationToastContainer';
import {
  notifyLayerExecution,
  notifyTakeProfit,
  notifyPriceAlert,
  sendBrowserNotification,
  getNotificationPermission,
  requestNotificationPermission,
  NotificationPermissionState,
} from './services/notificationService';

const HomeView = lazy(() => import('./views/HomeView').then((module) => ({ default: module.HomeView })));
const WalletView = lazy(() => import('./views/WalletView').then((module) => ({ default: module.WalletView })));
const TradingPositionsView = lazy(() => import('./views/TradingPositionsView').then((module) => ({ default: module.TradingPositionsView })));
const AccountView = lazy(() => import('./views/AccountView').then((module) => ({ default: module.AccountView })));
const AdminUserManagementModal = lazy(() => import('./components/admin/AdminUserManagementModal').then((module) => ({ default: module.AdminUserManagementModal })));
const AveragingMatrixModal = lazy(() => import('./components/modals/AveragingMatrixModal').then((module) => ({ default: module.AveragingMatrixModal })));
const DepositModal = lazy(() => import('./components/modals/DepositModal').then((module) => ({ default: module.DepositModal })));
const WithdrawModal = lazy(() => import('./components/modals/WithdrawModal').then((module) => ({ default: module.WithdrawModal })));
const TransferMemberModal = lazy(() => import('./components/modals/TransferMemberModal').then((module) => ({ default: module.TransferMemberModal })));
const GasFeeModal = lazy(() => import('./components/modals/GasFeeModal').then((module) => ({ default: module.GasFeeModal })));
const ProfitShareModal = lazy(() => import('./components/modals/ProfitShareModal').then((module) => ({ default: module.ProfitShareModal })));
const ApiKeyModal = lazy(() => import('./components/modals/ApiKeyModal').then((module) => ({ default: module.ApiKeyModal })));
const ExchangeCoinsCheckerModal = lazy(() => import('./components/modals/ExchangeCoinsCheckerModal').then((module) => ({ default: module.ExchangeCoinsCheckerModal })));
const ActivationFeeModal = lazy(() => import('./components/modals/ActivationFeeModal').then((module) => ({ default: module.ActivationFeeModal })));
const Google2faModal = lazy(() => import('./components/modals/Google2faModal').then((module) => ({ default: module.Google2faModal })));
const SecurityVerificationModal = lazy(() => import('./components/modals/SecurityVerificationModal').then((module) => ({ default: module.SecurityVerificationModal })));
const GmailVerificationModal = lazy(() => import('./components/modals/GmailVerificationModal').then((module) => ({ default: module.GmailVerificationModal })));
const AuthModal = lazy(() => import('./components/modals/AuthModal').then((module) => ({ default: module.AuthModal })));
const PriceAlertModal = lazy(() => import('./components/modals/PriceAlertModal').then((module) => ({ default: module.PriceAlertModal })));
const BacktestWorkspace = lazy(() => import('./views/BacktestWorkspace').then((module) => ({ default: module.BacktestWorkspace })));

function LazyMount({ isOpen, children }: { isOpen: boolean; children: ReactNode }) {
  const [hasOpened, setHasOpened] = useState(isOpen);

  useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);

  return hasOpened ? children : null;
}

const ROUTE_BY_PATH: Record<string, NavigationRoute> = {
  '/': 'home',
  '/wallet': 'wallet',
  '/bot': 'bot',
  '/trading': 'trading',
  '/akun': 'akun',
  '/backtest': 'trading',
};

function pathForRoute(route: NavigationRoute): string {
  return route === 'home' ? '/' : `/${route}`;
}

function resolveQueryUpdate<T>(
  current: T | undefined,
  updater: T | ((current: T) => T),
  fallback: T
): T {
  return typeof updater === 'function'
    ? (updater as (current: T) => T)(current ?? fallback)
    : updater;
}

// Cryptographically safe or entropy-rich unique ID generator to prevent key collision across synchronous loops
const generateUniqueId = (prefix: string = 'id'): string => {
  const randomPart = Math.random().toString(36).substring(2, 9);
  return `${prefix}-${Date.now()}-${randomPart}`;
};

function AppContent() {
  assertProductionSafeMode();

  if (isDemoMode) {
    console.warn('[GAIN] Running in demo mode. This build should not be used for public production traffic.');
  }

  const navigate = useNavigate();
  const location = useLocation();
  const currentRoute = ROUTE_BY_PATH[location.pathname] || 'home';
  const handleRouteChange = (route: NavigationRoute) => navigate(pathForRoute(route));
  const [currentExchange, setCurrentExchange] = useState<ExchangeName>('Binance');
  const exchangeSwitchRequestRef = useRef(0);
  const exchangePortfolioGateRef = useRef(new Map<string, ReturnType<typeof createSnapshotGateState>>());
  const exchangePortfolioConfigRef = useRef(new Map<string, ConnectedExchangeConfig>());
  const exchangePortfolioInFlightRef = useRef(new Set<string>());
  const queryClientInstance = useQueryClient();
  const uiModals = useUiStore((state) => state.modals);
  const setUiModalOpen = useUiStore((state) => state.setModalOpen);

  const {
    currentUser,
    openLogin,
    logout,
    isAuthModalOpen,
    setIsAuthModalOpen,
    authModalMode,
    pendingSponsorId,
    isAdmin,
  } = useAuth();

  const isAuthenticatedUser = Boolean(currentUser && currentUser.uid !== 'gain-usr-demo');
  const protectAction = <T extends (...args: any[]) => any>(action: T): T => ((...args: Parameters<T>) => {
    if (!isAuthenticatedUser) {
      openLogin();
      return undefined;
    }
    return action(...args);
  }) as T;

  const userDataKey = currentUser?.uid || 'anonymous';
  const walletQueryKey = useMemo(() => ['user-data', userDataKey, 'wallet'] as const, [userDataKey]);
  const transactionsQueryKey = useMemo(() => ['user-data', userDataKey, 'transactions'] as const, [userDataKey]);
  const alertsQueryKey = useMemo(() => ['user-data', userDataKey, 'price-alerts'] as const, [userDataKey]);
  const previousUserDataKeyRef = useRef(userDataKey);

  useEffect(() => {
    const previousUserDataKey = previousUserDataKeyRef.current;
    if (previousUserDataKey !== userDataKey) {
      queryClientInstance.removeQueries({ queryKey: ['user-data', previousUserDataKey] });
      previousUserDataKeyRef.current = userDataKey;
    }
  }, [queryClientInstance, userDataKey]);

  const wallet = useQuery({ queryKey: walletQueryKey, queryFn: async () => initialWallet, initialData: initialWallet, enabled: false }).data;
  const currentExchangeConfig =
    (wallet.connectedExchange && normalizeExchangeName(wallet.connectedExchange.exchange) === normalizeExchangeName(currentExchange))
      ? wallet.connectedExchange
      : (wallet.connectedExchanges || []).find((item) => normalizeExchangeName(item.exchange) === normalizeExchangeName(currentExchange));
  const currentExchangeIsSandbox = currentExchangeConfig?.isSandbox === true;
  const positionsQueryKey = useMemo(
    () => ['user-data', userDataKey, 'positions', currentExchange, currentExchangeIsSandbox] as const,
    [userDataKey, currentExchange, currentExchangeIsSandbox]
  );
  const tradesQueryKey = useMemo(
    () => ['user-data', userDataKey, 'trades', currentExchange, currentExchangeIsSandbox] as const,
    [userDataKey, currentExchange, currentExchangeIsSandbox]
  );
  const positions = useQuery({ queryKey: positionsQueryKey, queryFn: async () => initialPositions, initialData: initialPositions, enabled: false }).data;
  const transactions = useQuery({ queryKey: transactionsQueryKey, queryFn: async () => initialTransactions, initialData: initialTransactions, enabled: false }).data;
  const tradeHistory = useQuery({ queryKey: tradesQueryKey, queryFn: async () => [] as TradeRecord[], initialData: [] as TradeRecord[], enabled: false }).data;
  const activeTradeHistory = filterExchangeScoped(tradeHistory, currentExchange, currentExchangeIsSandbox);
  const priceAlerts = useQuery({ queryKey: alertsQueryKey, queryFn: async () => [] as PriceAlert[], initialData: [] as PriceAlert[], enabled: false }).data;
  const transactionCursorRef = useRef<FirestorePageCursor | null>(null);
  const tradeCursorRef = useRef<number | null>(null);
  const hasLoadedOlderTransactionsRef = useRef(false);
  const [hasMoreTransactions, setHasMoreTransactions] = useState(false);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(false);
  const [hasMoreTrades, setHasMoreTrades] = useState(false);
  const [isLoadingTrades, setIsLoadingTrades] = useState(false);

  const setWallet = (updater: UserWallet | ((current: UserWallet) => UserWallet)) => {
    queryClientInstance.setQueryData<UserWallet>(walletQueryKey, (current) => resolveQueryUpdate(current, updater, initialWallet));
  };
  const setPositions = (updater: TradingPosition[] | ((current: TradingPosition[]) => TradingPosition[])) => {
    queryClientInstance.setQueryData<TradingPosition[]>(positionsQueryKey, (current) => resolveQueryUpdate(current, updater, initialPositions));
  };
  const setTransactions = (updater: TransactionRecord[] | ((current: TransactionRecord[]) => TransactionRecord[])) => {
    queryClientInstance.setQueryData<TransactionRecord[]>(transactionsQueryKey, (current) => resolveQueryUpdate(current, updater, initialTransactions));
  };
  const setTradeHistoryForSource = (
    exchange: ExchangeName,
    isSandbox: boolean,
    updater: TradeRecord[] | ((current: TradeRecord[]) => TradeRecord[]),
  ) => {
    const sourceQueryKey = ['user-data', userDataKey, 'trades', exchange, isSandbox] as const;
    queryClientInstance.setQueryData<TradeRecord[]>(sourceQueryKey, (current) => resolveQueryUpdate(current, updater, []));
  };
  const setPriceAlerts = (updater: PriceAlert[] | ((current: PriceAlert[]) => PriceAlert[])) => {
    queryClientInstance.setQueryData<PriceAlert[]>(alertsQueryKey, (current) => resolveQueryUpdate(current, updater, []));
  };

  const tickerQuery = useQuery<BatchTickerResponse>({
    queryKey: ['exchange-tickers', currentExchange, currentExchangeIsSandbox],
    queryFn: () =>
      loadTickerBatch(currentExchange === 'Bybit Indonesia' ? 'bybit' : currentExchange.toLowerCase(), LIVE_TICKER_SYMBOLS, currentExchangeIsSandbox),
    staleTime: 10_000,
    refetchInterval: 12_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: 1,
  });
  const [liveTickerFeed, setLiveTickerFeed] = useState<{
    prices: Record<string, number>;
    receivedAt: number;
  } | null>(null);

  // Per-exchange position cache: stores positions independently per exchange so switching doesn't lose data
  const [positionsByExchange, setPositionsByExchange] = useState<Map<string, TradingPosition[]>>(new Map());

  // Source-of-truth is Firestore. Local storage is no longer used as primary application state.
  useEffect(() => {
    if (typeof window === 'undefined' || !currentUser?.uid) return;
    if (wallet && wallet.memberId) {
      localStorage.setItem(`gain_wallet_${currentUser.uid}`, JSON.stringify(wallet));
    }
  }, [wallet, currentUser]);

  useEffect(() => {
    if (typeof window === 'undefined' || !currentUser?.uid) return;
    if (positions) {
    }
  }, [positions, currentUser]);

  useEffect(() => {
    if (typeof window === 'undefined' || !currentUser?.uid) return;
    if (transactions) {
      localStorage.setItem(`gain_transactions_${currentUser.uid}`, JSON.stringify(transactions));
    }
  }, [transactions, currentUser]);


  // Sync Google user profile immediately to wallet state
  useEffect(() => {
    if (currentUser) {
      const googleName = currentUser.displayName || currentUser.email?.split('@')[0] || 'Member GAIN';
      const googleEmail = currentUser.email || 'user@gainkoin.io';
      setWallet((prev) => ({
        ...prev,
        username: googleName,
        email: googleEmail,
      }));
    }
  }, [currentUser]);

  // Price Alerts State & Real-time Subscription
  const isPriceAlertModalOpen = uiModals.priceAlert;
  const setIsPriceAlertModalOpen = (isOpen: boolean) => setUiModalOpen('priceAlert', isOpen);
  const [priceAlertSymbol, setPriceAlertSymbol] = useState<string>('BTC/USDT');
  const priceAlertsRef = useRef<PriceAlert[]>([]);

  useEffect(() => {
    priceAlertsRef.current = priceAlerts;
  }, [priceAlerts]);

  useEffect(() => {
    const unsubAlerts = subscribeToPriceAlerts(currentUser?.uid, (remoteAlerts) => {
      setPriceAlerts(remoteAlerts);
    });
    return () => unsubAlerts();
  }, [currentUser]);

  // In-app notifications & browser permission state
  const [inAppNotifications, setInAppNotifications] = useState<AppNotification[]>([]);
  const [browserNotifPerm, setBrowserNotifPerm] = useState<NotificationPermissionState>('default');
  const triggeredTpMapRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    setBrowserNotifPerm(getNotificationPermission());
  }, []);

  const handleRequestBrowserPermission = async () => {
    const perm = await requestNotificationPermission();
    setBrowserNotifPerm(perm);
    if (perm === 'granted') {
      sendBrowserNotification('🔔 Notifikasi Browser GAIN Aktif!', {
        body: 'Anda akan menerima notifikasi otomatis saat harga koin mencapai target, layer averaging terisi, dan terkena Take Profit.',
      });
      addInAppNotification({
        type: 'info',
        title: 'Notifikasi Browser Diaktifkan',
        message: 'GAIN siap mengirimkan notifikasi target harga, order layer, dan take profit.',
      });
    }
  };

  const addInAppNotification = (notif: Omit<AppNotification, 'id' | 'timestamp'>) => {
    const newNotif: AppNotification = {
      ...notif,
      id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
    };
    setInAppNotifications((prev) => [newNotif, ...prev.filter((n) => n.id !== newNotif.id)].slice(0, 6));
    setTimeout(() => {
      setInAppNotifications((prev) => prev.filter((n) => n.id !== newNotif.id));
    }, 7000);
  };

  const handleDismissNotification = (id: string) => {
    setInAppNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const showToast = (message: string, type: 'success' | 'info' | 'error' = 'info') => {
    addInAppNotification({
      type: type === 'success' ? 'take_profit' : 'info',
      title: type === 'success' ? 'Notifikasi GAIN' : 'Pemberitahuan Sistem',
      message,
    });
  };

  const handleOpenPriceAlert = (symbol?: string) => {
    if (symbol) setPriceAlertSymbol(symbol);
    setIsPriceAlertModalOpen(true);
  };

  const currentPricesMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of positions) {
      if (typeof p.price === 'number') map[p.pair] = p.price;
    }
    for (const [pair, ticker] of Object.entries((tickerQuery.data?.tickers || {}) as Record<string, { last:number; percentage?:number; timestamp?:number }>)) {
      if (typeof ticker.last === 'number' && ticker.last > 0) map[pair] = ticker.last;
    }
    if (
      currentExchange.toLowerCase() === 'binance'
      && liveTickerFeed
      && Date.now() - liveTickerFeed.receivedAt < 20000
    ) {
      Object.assign(map, liveTickerFeed.prices);
    }
    return map;
  }, [positions, tickerQuery.dataUpdatedAt, currentExchange, liveTickerFeed]);

  // Final GAIN segmentation:
  // - Identity/member state answers WHO the user is and whether the account is usable.
  // - License state answers WHICH paid entitlements the member owns.
  // - Security elevation is requested on-demand by protected actions; it is never a
  //   dashboard/login gate.  `accountStatus` remains a backward-compatible alias for
  //   an ACTIVE license in the UI read model.
  const [isSecurityVerificationOpen, setIsSecurityVerificationOpen] = useState(false);
  const [securityVerificationReason, setSecurityVerificationReason] = useState('');

  useEffect(() => {
    const handleSecurityElevationRequired = (event: Event) => {
      if (!isAuthenticatedUser) return;
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setSecurityVerificationReason(
        detail?.message || 'Tindakan ini memerlukan verifikasi keamanan tambahan.'
      );
      setIsSecurityVerificationOpen(true);
    };

    window.addEventListener('gain:security-elevation-required', handleSecurityElevationRequired);
    return () => {
      window.removeEventListener('gain:security-elevation-required', handleSecurityElevationRequired);
    };
  }, [isAuthenticatedUser]);

  // Exchange snapshots from legacy builds must never be resurrected.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prefixes = ['gain_exchange_', 'gain_portfolio_', 'gain_active_exchange_', 'gain_trades_', 'gain_positions_'];
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) window.localStorage.removeItem(key);
    }
  }, [currentUser?.uid]);

  const beginExchangePortfolioRequest = (exchange: ExchangeName, isSandbox: boolean) => {
    const key = snapshotKey(exchange, isSandbox);
    if (exchangePortfolioInFlightRef.current.has(key)) return null;
    exchangePortfolioInFlightRef.current.add(key);
    const current = exchangePortfolioGateRef.current.get(key) || createSnapshotGateState();
    const { requestSeq, nextState } = nextRequestSequence(current);
    exchangePortfolioGateRef.current.set(key, nextState);
    return { key, requestSeq };
  };

  const finishExchangePortfolioRequest = (key: string) => {
    exchangePortfolioInFlightRef.current.delete(key);
  };

  const acceptExchangePortfolioSnapshot = (
    exchange: ExchangeName,
    isSandbox: boolean,
    requestSeq: number,
    candidate: PortfolioSnapshotCandidate,
    previousConfig?: ConnectedExchangeConfig | null,
  ) => {
    const key = snapshotKey(exchange, isSandbox);
    const currentState = exchangePortfolioGateRef.current.get(key) || createSnapshotGateState();
    const decision = decidePortfolioSnapshot(currentState, candidate, requestSeq, previousConfig || exchangePortfolioConfigRef.current.get(key));
    exchangePortfolioGateRef.current.set(key, decision.nextState);
    if (!decision.accept) {
      console.info('[EXCHANGE_PORTFOLIO_SNAPSHOT_PRESERVED]', { exchange, isSandbox, requestSeq, reason: decision.reason });
      return false;
    }
    exchangePortfolioConfigRef.current.set(key, previousConfig ? { ...previousConfig } : ({} as ConnectedExchangeConfig));
    return true;
  };

  const buildPortfolioCandidate = (exchange: ExchangeName, isSandbox: boolean, data: any): PortfolioSnapshotCandidate => ({
    exchange,
    isSandbox,
    usdtBalance: Number(data?.usdtBalance ?? 0),
    usdtAvailable: Number(data?.usdtAvailable ?? data?.usdtBalance ?? 0),
    usdtTotalBalance: Number(data?.usdtTotalBalance ?? data?.usdtBalance ?? 0),
    totalPortfolioUsdt: Number(data?.totalPortfolioUsdt ?? 0),
    rawAssetCount: Number(data?.rawAssetCount ?? 0),
    unvaluedDefaultAssetCount: Number(data?.unvaluedDefaultAssetCount ?? 0),
    valuationScope: data?.valuationScope,
    portfolioAssets: Array.isArray(data?.portfolioAssets) ? data.portfolioAssets : [],
    portfolioAsOf: Number(data?.portfolioAsOf ?? Date.now()),
  });

  // Firestore provides exchange connection metadata, not live exchange balances.
  // Never let the 5-second metadata poll replace a newer authenticated portfolio snapshot.
  // Firestore Real-time Subscriptions
  useEffect(() => {
    if (!currentUser || !currentUser.uid) {
      return;
    }

    transactionCursorRef.current = null;
    tradeCursorRef.current = null;
    hasLoadedOlderTransactionsRef.current = false;
    setHasMoreTransactions(false);
    setHasMoreTrades(false);

    const unsubWallet = subscribeToUserWallet(currentUser.uid, (remoteWallet) => {
      queryClientInstance.setQueryData<UserWallet>(walletQueryKey, (previous) =>
        mergeServerWalletMetadataPreservingLiveExchange(previous, remoteWallet)
      );
    });

    const unsubPositions = subscribeToUserPositions(currentUser.uid, currentExchange, (remotePositions) => {
      const normalizedExchange = String(currentExchange || '').toLowerCase();
      const exchangePositions = remotePositions.filter(
        (position: TradingPosition) =>
          String(position.exchange || '').toLowerCase() === normalizedExchange &&
          position.isSandbox === currentExchangeIsSandbox
      );
      queryClientInstance.setQueryData<TradingPosition[]>(positionsQueryKey, (previous) => {
        const prevMap = new Map((previous || []).map((p) => [p.pair || p.id, p]));
        const currentTickers = (tickerQuery.data?.tickers || {}) as Record<string, { last?: number; percentage?: number }>;
        return exchangePositions.map((pos) => {
          const prev = prevMap.get(pos.pair || pos.id);
          const ticker = currentTickers[pos.pair];
          const resolvedPrice = (typeof ticker?.last === 'number' && ticker.last > 0)
            ? ticker.last
            : (pos.price > 0 ? pos.price : (prev?.price || 0));
          const resolvedChange = (typeof ticker?.percentage === 'number')
            ? ticker.percentage
            : (pos.change24h !== 0 ? pos.change24h : (prev?.change24h ?? 0));
          return {
            ...pos,
            price: resolvedPrice,
            change24h: resolvedChange,
          };
        });
      });
    });

    const unsubTransactions = subscribeToUserTransactions(
      currentUser.uid,
      (remoteTransactions) => {
        queryClientInstance.setQueryData<TransactionRecord[]>(transactionsQueryKey, (previous) => {
          const records = new Map((previous || []).map((transaction) => [transaction.id, transaction]));
          remoteTransactions.forEach((transaction) => records.set(transaction.id, transaction));
          return Array.from(records.values()).sort((a, b) => {
            const timeA = Date.parse(a.createdAt || a.timestamp || '') || 0;
            const timeB = Date.parse(b.createdAt || b.timestamp || '') || 0;
            return timeB - timeA;
          });
        });
      },
      (cursor, hasMore) => {
        if (hasLoadedOlderTransactionsRef.current) return;
        transactionCursorRef.current = cursor;
        setHasMoreTransactions(hasMore);
      }
    );

    // Authoritative PostgreSQL Ledger initial sync
    getUserTransactions({ limit: 50, offset: 0 }).then((res) => {
      if (res?.success && Array.isArray(res.transactions) && res.transactions.length > 0) {
        queryClientInstance.setQueryData<TransactionRecord[]>(transactionsQueryKey, (previous) => {
          const records = new Map((previous || []).map((t) => [t.id, t]));
          res.transactions.forEach((t: any) => records.set(t.id, t));
          return Array.from(records.values()).sort((a, b) => {
            const timeA = Date.parse(a.createdAt || a.timestamp || '') || 0;
            const timeB = Date.parse(b.createdAt || b.timestamp || '') || 0;
            return timeB - timeA;
          });
        });
      }
    }).catch(() => {});

    return () => {
      unsubWallet();
      unsubPositions();
      unsubTransactions();
    };
  }, [currentUser, queryClientInstance, walletQueryKey, positionsQueryKey, transactionsQueryKey, tradesQueryKey, currentExchange, currentExchangeIsSandbox]);

  // The wallet read model is allowed to confirm the selected exchange, but it
  // must never overwrite a newer user selection with an arbitrary server-first
  // exchange. The selector is persisted locally by handleSelectActiveExchange.
  useEffect(() => {
    const active = wallet.activeExchange || wallet.connectedExchange?.exchange;
    if (active) {
      const activeDesc = getExchangeDescriptor(active);
      const canonicalName = (activeDesc?.name || active) as ExchangeName;
      if (normalizeExchangeName(canonicalName) !== normalizeExchangeName(currentExchange)) {
        const exists = (wallet.connectedExchanges || []).some(
          (item) => normalizeExchangeName(item.exchange) === normalizeExchangeName(canonicalName) && item.isConnected !== false
        );
        if (exists || !wallet.connectedExchanges?.length) {
          setCurrentExchange(canonicalName);
        }
      }
    }
  }, [wallet.activeExchange, wallet.connectedExchange?.exchange, wallet.connectedExchanges, currentExchange]);

  // Real-time Binance market ticker stream (WebSocket)
  const wsTickers = useBinanceWebSocket(currentExchangeIsSandbox);

  useEffect(() => {
    let isMounted = true;
    setLiveTickerFeed(null);

    console.info('[CLIENT_WS_ENABLED]', {
      exchange: currentExchange,
      reason: 'direct_binance_stream',
    });

    return () => {
      isMounted = false;
    };
  }, [
    currentExchange,
    wallet.connectedExchange?.isSandbox,
    currentUser?.uid,
  ]);

  useEffect(() => {
    const restTickers = tickerQuery.data?.tickers as Record<string, { last:number; percentage?:number }> | undefined;
    const tickers = { ...restTickers, ...wsTickers };
    
    if (Object.keys(tickers).length === 0) return;

    setPositions((prev) => prev.map((position) => {
      const ticker = tickers[position.pair];
      if (!ticker?.last) return position;
      return {
        ...position,
        price: ticker.last,
        change24h: Number.isFinite(Number(ticker.percentage)) ? Number(ticker.percentage) : position.change24h,
      };
    }));

    const prices: Record<string, number> = {};
    for (const [symbol, ticker] of Object.entries(tickers)) {
      if (ticker.last) prices[symbol] = ticker.last;
    }

    setPriceAlerts(checkPriceAlerts(priceAlertsRef.current, prices, currentUser?.uid, (triggeredAlert, price) => {
      showToast(
        `Price Alert: ${triggeredAlert.symbol} mencapai target $${formatUsdt(price)}!`,
        'success'
      );
    }));
  }, [tickerQuery.dataUpdatedAt, currentUser?.uid, wsTickers]);

  // Exchange credentials stay in memory only and must be re-entered after a page reload.
  const [activeApiCreds, setActiveApiCreds] = useState<{
    exchange: ExchangeName;
    apiKey: string;
    secret: string;
    password?: string;
    isSandbox: boolean;
  } | null>(null);

  // Connected credentials for this runtime only; persisted exchange metadata remains masked.
  const [activeApiCredsMap, setActiveApiCredsMap] = useState<
    Map<
      ExchangeName,
      {
        exchange: ExchangeName;
        apiKey: string;
        secret: string;
        password?: string;
        isSandbox: boolean;
      }
    >
  >(new Map());

  const [engineBots, setEngineBots] = useState<BotRuntimeState[]>([]);
  const [engineStatusState, setEngineStatusState] = useState<'loading' | 'ready' | 'error'>('loading');

  const handleReconcileBot = async (botId: string) => {
    try {
      return await reconcileBot(botId);
    } finally {
      // The engine-status poll will refresh the authoritative runner state.
    }
  };

  const handleRebuildBotPosition = async (botId: string, pair?: string) => {
    try {
      return await rebuildBotPositionFromFills(botId, pair);
    } finally {
      // The engine-status poll refreshes the authoritative runner state.
    }
  };

  const prevExchangeBotsJsonRef = useRef<string>('');

  useEffect(() => {
    if (!currentUser?.uid || !isAuthenticatedUser) {
      setEngineBots([]);
      setEngineStatusState('loading');
      prevExchangeBotsJsonRef.current = '';
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await getBotEngineStatus();
        if (cancelled) return;
        if (!Array.isArray(data.bots)) {
          setEngineBots([]);
          setEngineStatusState('error');
          prevExchangeBotsJsonRef.current = '';
          return;
        }
        const normalizedBots = data.bots.map(normalizeBotRuntimeState);
        const exchangeBots = normalizedBots.filter(
          (bot) => String(bot.exchange || '').toLowerCase() === String(currentExchange || '').toLowerCase()
        );

        // Only trigger React re-render if bot payload actually changed
        const currentJson = JSON.stringify(exchangeBots);
        if (prevExchangeBotsJsonRef.current !== currentJson) {
          prevExchangeBotsJsonRef.current = currentJson;
          setEngineBots(exchangeBots);
        }
        setEngineStatusState((prev) => (prev === 'ready' ? prev : 'ready'));
      } catch {
        if (!cancelled) setEngineStatusState('error');
      }
    };

    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [currentUser?.uid, isAuthenticatedUser, currentExchange]);

  // Remove credentials written by older app versions; secrets are never persisted client-side.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.removeItem('gain_active_api_creds');
    localStorage.removeItem('gain_active_api_creds_map');
    sessionStorage.removeItem('gain_active_api_creds');
  }, []);

  // Evaluate if current user session is in Demo / Testnet mode
  const isDemoOrTestnet = Boolean(wallet.isDemoSimulation);

  // Handle Exchange API Connect Success (supports connecting multiple exchangers to 1 Google account)
  const handleConnectExchangeSuccess = async (
    exchange: ExchangeName,
    balance: number,
    isSandbox: boolean,
    apiKey = '',
    secret?: string,
    passphrase?: string,
    portfolioAssets?: Array<{
      coin: string;
      pair: string;
      total: number;
      price: number;
      change24h: number;
      valueUsdt: number;
    }>,
    totalPortfolioUsdt?: number,
    snapshotMeta?: {
      usdtAvailable?: number;
      usdtTotalBalance?: number;
      rawAssetCount?: number;
      unvaluedDefaultAssetCount?: number;
      valuationScope?: 'DEFAULT_12_COINS';
    }
  ) => {
    setCurrentExchange(exchange);

    let credentialSaveResult: any = null;
    if (apiKey && secret) {
      if (currentUser && !isDemoMode) {
        credentialSaveResult = await storeBotCredentials({ exchange, apiKey, secret, password: passphrase, isSandbox });
      }
      const creds = {
        exchange,
        apiKey,
        secret,
        password: passphrase,
        isSandbox,
      };
      setActiveApiCreds(creds);
      setActiveApiCredsMap((prev) => new Map(prev).set(exchange, creds));
    }

    const existingExchangeConfig = (wallet.connectedExchanges || []).find((item) => item.exchange === exchange) || (wallet.connectedExchange?.exchange === exchange ? wallet.connectedExchange : undefined);
    const maskedKey = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : (existingExchangeConfig?.apiKeyMasked || 'API_CONNECTED');
    const safePortfolioAssets = Array.isArray(portfolioAssets)
      ? portfolioAssets.filter((asset) => typeof asset?.coin === 'string' && asset.coin.trim().length > 0)
      : [];
    const connectCandidate = buildPortfolioCandidate(exchange, isSandbox, {
      usdtBalance: balance,
      usdtAvailable: snapshotMeta?.usdtAvailable ?? balance,
      usdtTotalBalance: snapshotMeta?.usdtTotalBalance ?? balance,
      totalPortfolioUsdt,
      rawAssetCount: snapshotMeta?.rawAssetCount ?? safePortfolioAssets.length,
      unvaluedDefaultAssetCount: snapshotMeta?.unvaluedDefaultAssetCount ?? 0,
      valuationScope: snapshotMeta?.valuationScope,
      portfolioAssets: safePortfolioAssets,
      portfolioAsOf: Date.now(),
    });
    const connectKey = snapshotKey(exchange, isSandbox);
    const connectState = exchangePortfolioGateRef.current.get(connectKey) || createSnapshotGateState();
    const connectSequence = Math.max(connectState.latestRequestSeq + 1, 1);
    exchangePortfolioGateRef.current.set(connectKey, { ...connectState, latestRequestSeq: connectSequence });
    const acceptConnectionSnapshot = decidePortfolioSnapshot(
      connectState,
      connectCandidate,
      connectSequence,
      existingExchangeConfig,
    );
    exchangePortfolioGateRef.current.set(connectKey, acceptConnectionSnapshot.nextState);
    const useIncomingPortfolio = acceptConnectionSnapshot.accept || !existingExchangeConfig;
    if (!acceptConnectionSnapshot.accept && existingExchangeConfig) {
      console.info('[EXCHANGE_CONNECT_SNAPSHOT_PRESERVED]', { exchange, isSandbox, reason: acceptConnectionSnapshot.reason });
    }
    const exchangeConfig: ConnectedExchangeConfig = {
      exchange,
      isConnected: true,
      isSandbox,
      apiKeyMasked: maskedKey,
      usdtBalance: useIncomingPortfolio ? connectCandidate.usdtBalance : Number(existingExchangeConfig?.usdtBalance || 0),
      usdtAvailable: useIncomingPortfolio ? connectCandidate.usdtAvailable : Number(existingExchangeConfig?.usdtAvailable ?? existingExchangeConfig?.usdtBalance ?? 0),
      usdtTotalBalance: useIncomingPortfolio ? connectCandidate.usdtTotalBalance : Number(existingExchangeConfig?.usdtTotalBalance ?? existingExchangeConfig?.usdtBalance ?? 0),
      rawAssetCount: useIncomingPortfolio ? connectCandidate.rawAssetCount : existingExchangeConfig?.rawAssetCount,
      unvaluedDefaultAssetCount: useIncomingPortfolio ? connectCandidate.unvaluedDefaultAssetCount : existingExchangeConfig?.unvaluedDefaultAssetCount,
      valuationScope: useIncomingPortfolio ? connectCandidate.valuationScope : existingExchangeConfig?.valuationScope,
      lastSynced: useIncomingPortfolio ? new Date().toLocaleTimeString() : (existingExchangeConfig?.lastSynced || new Date().toLocaleTimeString()),
      isActive: true,
      totalPortfolioUsdt: useIncomingPortfolio ? connectCandidate.totalPortfolioUsdt : existingExchangeConfig?.totalPortfolioUsdt,
      portfolioAssets: useIncomingPortfolio ? safePortfolioAssets : (existingExchangeConfig?.portfolioAssets || []),
      portfolioAsOf: useIncomingPortfolio ? connectCandidate.portfolioAsOf : existingExchangeConfig?.portfolioAsOf,
      exchangeAccountId: credentialSaveResult?.exchangeAccountId || existingExchangeConfig?.exchangeAccountId,
      identityType: credentialSaveResult?.identityType || existingExchangeConfig?.identityType,
      identityHint: credentialSaveResult?.identityHint || existingExchangeConfig?.identityHint,
      reportedIdentityKey: credentialSaveResult?.reportedIdentityKey || existingExchangeConfig?.reportedIdentityKey,
      credentialVersion: credentialSaveResult?.credentialVersion || existingExchangeConfig?.credentialVersion || 1,
      credentialStatus: credentialSaveResult?.credentialStatus || existingExchangeConfig?.credentialStatus || 'ACTIVE',
      exchangeAccountStatus: credentialSaveResult?.exchangeAccountStatus || existingExchangeConfig?.exchangeAccountStatus || 'ACTIVE',
      portfolioSyncStatus: 'LIVE',
      dataSource: 'EXCHANGE_API',
      lastSyncError: undefined,
    };


    const totalAllocated = useIncomingPortfolio
      ? Number(safePortfolioAssets.reduce((sum, a) => sum + (Number(a.valueUsdt) || 0), 0).toFixed(2))
      : Math.max(0, Number(exchangeConfig.totalPortfolioUsdt || 0) - Number(exchangeConfig.usdtTotalBalance || 0));

    const existingList =
      wallet.connectedExchanges && wallet.connectedExchanges.length > 0
        ? wallet.connectedExchanges
        : wallet.connectedExchange?.isConnected
        ? [wallet.connectedExchange]
        : [];

    const updatedList = [
      ...existingList
        .filter((e) => e.exchange !== exchange)
        .map((e) => ({ ...e, isActive: false })),
      exchangeConfig,
    ];

    setWallet((prev) => ({
      ...prev,
      allocatedAssetUsdt: totalAllocated,
      connectedExchange: exchangeConfig,
      connectedExchanges: updatedList,
      activeExchange: exchange,
    }));

    if (safePortfolioAssets.length > 0) {
      const activeCoinMap = new Map<string, (typeof safePortfolioAssets)[number]>(
        safePortfolioAssets
          .map((a) => [typeof a?.coin === 'string' ? a.coin.toUpperCase() : '', a] as const)
          .filter(([key]) => Boolean(key))
      );

      // Save current positions for the previously active exchange before overwriting
      setPositionsByExchange((prev) => {
        const next = new Map(prev);
        const prevExchange = wallet.activeExchange || currentExchange;
        if (prevExchange && prevExchange !== exchange) {
          const previousConfig = wallet.connectedExchanges?.find((item) => item.exchange === prevExchange)
            || (wallet.connectedExchange?.exchange === prevExchange ? wallet.connectedExchange : undefined);
          const previousMode = previousConfig?.isSandbox === true;
          next.set(`${userDataKey}:${prevExchange}:${previousMode ? 'sandbox' : 'live'}`, positions);
        }
        return next;
      });

      setPositions((prev) => {
        // Start from cached positions for this exchange if available, otherwise use current
        const targetPositionKey = `${userDataKey}:${exchange}:${isSandbox ? 'sandbox' : 'live'}`;
        const basePositions = positionsByExchange.get(targetPositionKey) || prev;
        const updated = basePositions.map((pos) => {
          const matched = activeCoinMap.get(typeof pos?.coin === 'string' ? pos.coin.toUpperCase() : '');
          if (matched) {
            return {
              ...pos,
              allocationQty: `${matched.total} ${matched.coin}`,
              allocationUsdt: `~${matched.valueUsdt.toFixed(2)} USDT`,
              price: matched.price,
              change24h: matched.change24h,
              status: 'active' as const,
              statusLabel: 'HOLDING / ACTIVE',
              engine: `${exchange} Spot ${isSandbox ? '(Testnet)' : ''} · Saldo Riil`,
            };
          }
          return {
            ...pos,
            allocationQty: `0 ${pos.coin}`,
            allocationUsdt: '0.00 USDT',
            status: 'inactive' as const,
            statusLabel: 'STANDBY',
            engine: `${exchange} Spot ${isSandbox ? '(Testnet)' : ''} · Standby`,
          };
        });
        // Save updated positions for this exchange in cache
        setPositionsByExchange((prevMap) => {
          const nextMap = new Map(prevMap);
          nextMap.set(targetPositionKey, updated);
          return nextMap;
        });
        return updated;
      });
    } else {
      setPositions((prev) => {
        const updated = prev.map((pos) => ({
          ...pos,
          engine: `${exchange} Spot ${isSandbox ? '(Testnet)' : ''} · Standby Ready`,
        }));
        setPositionsByExchange((prevMap) => {
          const nextMap = new Map(prevMap);
          nextMap.set(`${userDataKey}:${exchange}:${isSandbox ? 'sandbox' : 'live'}`, updated);
          return nextMap;
        });
        return updated;
      });
    }

    if (currentUser) {
      try {
        await setActiveExchangeInFirestore(currentUser.uid, exchange);
      } catch (error) {
        console.warn('[ACTIVE_EXCHANGE_CONNECT_PERSIST_FAILED]', error);
      }
    }

    // Automatically fetch real trade history from exchange right upon connection
    if (currentUser) {
      fetchExchangeTrades({
        exchange: exchange.toLowerCase(),
        isSandbox,
        limit: 50,
      })
        .then(async (data) => {
          if (data.success && Array.isArray(data.trades)) {
            const mappedTrades: TradeRecord[] = data.trades.map((t: any) => ({
              id: `${exchange.toLowerCase()}:${t.id || `${t.symbol}:${t.timestamp}`}`,
              orderId: t.orderId || t.id,
              exchange: t.exchange || exchange,
              symbol: t.symbol,
              side: t.side,
              type: t.type || 'market',
              price: Number(t.price) || 0,
              amount: Number(t.amount) || 0,
              costUsdt: Number(t.costUsdt) || (Number(t.price) || 0) * (Number(t.amount) || 0),
              fee: t.fee,
              timestamp: t.timestamp || Date.now(),
              datetime: t.datetime || new Date().toISOString(),
              status: t.status || 'filled',
              isSandbox: t.isSandbox ?? isSandbox,
            }));
            const enrichedTrades = decorateTradesWithRealizedPnl(mappedTrades);
            setTradeHistoryForSource(exchange, isSandbox, enrichedTrades);
          }
        })
        .catch((err) => console.warn('Auto fetch trades error upon API connection:', err));
    }
  };

  // Switch Active Exchange among connected exchanges
  const handleSelectActiveExchange = async (targetExchange: ExchangeName) => {
    const switchRequestId = ++exchangeSwitchRequestRef.current;
    setCurrentExchange(targetExchange);
    tradeCursorRef.current = null;
    setHasMoreTrades(false);
    setIsLoadingTrades(false);
    const creds = activeApiCredsMap.get(targetExchange);
    if (creds) {
      setActiveApiCreds(creds);
    } else {
      setActiveApiCreds(null);
    }

    const existingList =
      wallet.connectedExchanges && wallet.connectedExchanges.length > 0
        ? wallet.connectedExchanges
        : wallet.connectedExchange?.isConnected
        ? [wallet.connectedExchange]
        : [];

    const targetConfig = existingList.find((c) => c.exchange === targetExchange);

    if (targetConfig) {
      if (!currentUser) return;
      const switchUserId = currentUser.uid;
      const updatedList = existingList.map((c) => ({
        ...c,
        isActive: c.exchange === targetExchange,
      }));

      setWallet((prev) => ({
        ...prev,
        connectedExchange: { ...targetConfig, isActive: true },
        connectedExchanges: updatedList,
        activeExchange: targetExchange,
      }));

      try {
        await setActiveExchangeInFirestore(switchUserId, targetExchange);
      } catch (error) {
        console.warn('[ACTIVE_EXCHANGE_PERSIST_FAILED]', error);
        // Fail closed: server persistence is the authoritative exchange context.
      }

      // Switching exchange is a data-context change, not just a UI selection.
      // Refresh the target exchange immediately from the authenticated server
      // adapter so balance/portfolio/orders/history do not remain stale.
      try {
        const portfolio = await fetchExchangePortfolio({
          exchange: targetExchange.toLowerCase(),
        });
        if (switchRequestId === exchangeSwitchRequestRef.current && portfolio?.success) {
          const request = beginExchangePortfolioRequest(targetExchange, Boolean(targetConfig.isSandbox));
          if (!request) return;
          const candidate = buildPortfolioCandidate(targetExchange, Boolean(targetConfig.isSandbox), portfolio);
          const accepted = acceptExchangePortfolioSnapshot(targetExchange, Boolean(targetConfig.isSandbox), request.requestSeq, candidate, targetConfig);
          finishExchangePortfolioRequest(request.key);
          if (!accepted) return;
          const portfolioAssets = candidate.portfolioAssets;
          const refreshedConfig: ConnectedExchangeConfig = {
            ...targetConfig,
            exchange: targetExchange,
            isActive: true,
            usdtBalance: Number(portfolio.usdtBalance || 0),
            usdtAvailable: Number(portfolio.usdtAvailable ?? portfolio.usdtBalance ?? 0),
            usdtTotalBalance: Number(portfolio.usdtTotalBalance ?? portfolio.usdtBalance ?? 0),
            totalPortfolioUsdt: Number(portfolio.totalPortfolioUsdt || 0),
            rawAssetCount: Number(portfolio.rawAssetCount || 0),
            unvaluedDefaultAssetCount: Number(portfolio.unvaluedDefaultAssetCount || 0),
            valuationScope: portfolio.valuationScope,
            portfolioAssets,
            portfolioAsOf: Number(portfolio.portfolioAsOf || Date.now()),
            portfolioSyncStatus: 'LIVE',
            dataSource: 'EXCHANGE_API',
            lastSynced: new Date().toISOString(),
          };
          const refreshedList: ConnectedExchangeConfig[] = existingList.map((item) => ({
            ...item,
            isActive: item.exchange === targetExchange,
          }));
          const targetIndex = refreshedList.findIndex((item) => item.exchange === targetExchange);
          if (targetIndex >= 0) refreshedList[targetIndex] = refreshedConfig;

          setWallet((prev) => ({
            ...prev,
            connectedExchange: refreshedConfig,
            connectedExchanges: refreshedList,
            activeExchange: targetExchange,
            allocatedAssetUsdt: Math.max(
              0,
              Number(portfolio.totalPortfolioUsdt || 0) - Number(portfolio.usdtBalance || 0)
            ),
          }));
        }
      } catch (error) {
        console.warn('[EXCHANGE_SWITCH_PORTFOLIO_REFRESH_FAILED]', {
          exchange: targetExchange,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (switchRequestId !== exchangeSwitchRequestRef.current) return;

      try {
        const tradeData = await fetchExchangeTrades({
          exchange: targetExchange.toLowerCase(),
          limit: 100,
        });
        if (switchRequestId === exchangeSwitchRequestRef.current && tradeData?.success && Array.isArray(tradeData.trades)) {
          const mappedTrades: TradeRecord[] = tradeData.trades.map((t: any) => ({
            id: `${targetExchange.toLowerCase()}:${t.id || `${t.symbol}:${t.timestamp}`}`,
            orderId: t.orderId || t.id,
            exchange: t.exchange || targetExchange,
            symbol: t.symbol,
            side: t.side,
            type: t.type || 'market',
            price: Number(t.price) || 0,
            amount: Number(t.amount) || 0,
            costUsdt: Number(t.costUsdt) || (Number(t.price) || 0) * (Number(t.amount) || 0),
            fee: t.fee,
            realizedPnl: Number.isFinite(Number(t.realizedPnl)) ? Number(t.realizedPnl) : undefined,
            pnlPercent: Number.isFinite(Number(t.pnlPercent)) ? Number(t.pnlPercent) : undefined,
            timestamp: t.timestamp || Date.now(),
            datetime: t.datetime || new Date().toISOString(),
            status: t.status || 'filled',
            isSandbox: t.isSandbox ?? targetConfig.isSandbox,
          }));
          setTradeHistoryForSource(targetExchange, Boolean(targetConfig.isSandbox), decorateTradesWithRealizedPnl(mappedTrades));
        }
      } catch (error) {
        console.warn('[EXCHANGE_SWITCH_TRADE_REFRESH_FAILED]', {
          exchange: targetExchange,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // Disconnect a specific exchange API or active exchange
  const handleDisconnectSingleExchange = async (targetExchange?: ExchangeName) => {
    ++exchangeSwitchRequestRef.current;
    const exToDisconnect = targetExchange || wallet.connectedExchange?.exchange || currentExchange;

    if (currentUser && !isDemoMode) {
      const result = await disconnectBotExchange(exToDisconnect);
      if (result.credentialsDeleted !== true) {
        throw new Error('Server belum mengonfirmasi penghapusan kredensial exchange.');
      }
    }

    setActiveApiCredsMap((prev) => {
      const nextMap = new Map(prev);
      nextMap.delete(exToDisconnect);
      return nextMap;
    });

    const existingList =
      wallet.connectedExchanges && wallet.connectedExchanges.length > 0
        ? wallet.connectedExchanges
        : wallet.connectedExchange?.isConnected
        ? [wallet.connectedExchange]
        : [];

    const remainingList = existingList.filter((c) => c.exchange !== exToDisconnect);
    let nextActive = remainingList.find((c) => c.isActive) || remainingList[0];

    if (nextActive) {
      nextActive = { ...nextActive, isActive: true };
      setCurrentExchange(nextActive.exchange);
      const nextCreds = activeApiCredsMap.get(nextActive.exchange) || null;
      setActiveApiCreds(nextCreds);

      setWallet((prev) => ({
        ...prev,
        connectedExchange: nextActive,
        connectedExchanges: remainingList.map((c) => ({
          ...c,
          isActive: c.exchange === nextActive.exchange,
        })),
        activeExchange: nextActive.exchange,
      }));
    } else {
      setActiveApiCreds(null);
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('gain_active_api_creds');
      }
      setWallet((prev) => ({
        ...prev,
        connectedExchange: {
          isConnected: false,
          exchange: currentExchange,
          isSandbox: false,
          apiKeyMasked: '',
          usdtBalance: 0,
          lastSynced: new Date().toLocaleTimeString(),
        },
        connectedExchanges: [],
        activeExchange: undefined,
      }));

      setPositions((prev) =>
        prev.map((pos) => ({
          ...pos,
          engine: 'Exchange API · Disconnected',
          status: 'inactive',
          statusLabel: 'STANDBY',
          allocationQty: `0 ${pos.coin}`,
          allocationUsdt: '0.00 USDT',
        }))
      );
    }

    const disconnectTx: TransactionRecord = {
      id: generateUniqueId('tx-disc'),
      title: `Disconnect API ${exToDisconnect}`,
      type: 'outflow',
      status: 'Success',
      statusColor: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      timestamp: 'Just now',
      counterparty: 'API Revoked',
      counterpartyLabel: 'Koneksi: ',
      amount: 0,
      amountFormatted: 'Diputuskan',
      feeInfo: 'Manual Disconnect',
    };
    setTransactions((prev) => {
      const map = new Map<string, TransactionRecord>();
      [disconnectTx, ...prev].forEach((item) => {
        if (item?.id && !map.has(item.id)) map.set(item.id, item);
      });
      return Array.from(map.values());
    });

    if (currentUser) {
      await disconnectSingleExchangeFromFirestore(currentUser.uid, exToDisconnect);
    }
  };

  // Disconnect exchange API, clear memory credentials and reset positions
  const handleDisconnectExchange = async () => {
    await handleDisconnectSingleExchange();
  };

  // Dedicated function to refresh real portfolio from active exchange credentials
  const [isRefreshingExchange, setIsRefreshingExchange] = useState(false);
  const resolveConnectedExchange = () => {
    const active = wallet.connectedExchange?.isConnected
      ? wallet.connectedExchange
      : (wallet.connectedExchanges || []).find((item) => item.isActive) || (wallet.connectedExchanges || []).find((item) => item.isConnected);
    return active || null;
  };

  // Refresh portfolio memakai credential tersimpan di server; browser tidak perlu memegang secret setelah reload.
  const handleRefreshExchangePortfolio = async () => {
    const connected = resolveConnectedExchange();
    if (!connected) {
      setIsApiKeyModalOpen(true);
      return;
    }

    setIsRefreshingExchange(true);
    const request = beginExchangePortfolioRequest(connected.exchange, connected.isSandbox);
    if (!request) {
      setIsRefreshingExchange(false);
      return;
    }
    setWallet((prev) => prev.connectedExchange ? { ...prev, connectedExchange: { ...prev.connectedExchange, portfolioSyncStatus: 'SYNCING', lastSyncError: undefined } } : prev);
    try {
      const data = await fetchExchangePortfolio({
        exchange: connected.exchange.toLowerCase(),
        isSandbox: connected.isSandbox,
      });

      if (data.success) {
        const candidate = buildPortfolioCandidate(connected.exchange, connected.isSandbox, data);
        const accepted = acceptExchangePortfolioSnapshot(connected.exchange, connected.isSandbox, request.requestSeq, candidate, connected);
        if (!accepted) return;
        await handleConnectExchangeSuccess(
          connected.exchange,
          candidate.usdtBalance,
          connected.isSandbox,
          '',
          undefined,
          undefined,
          candidate.portfolioAssets,
          candidate.totalPortfolioUsdt,
          {
            usdtAvailable: candidate.usdtAvailable,
            usdtTotalBalance: candidate.usdtTotalBalance,
            rawAssetCount: candidate.rawAssetCount,
            unvaluedDefaultAssetCount: candidate.unvaluedDefaultAssetCount,
            valuationScope: candidate.valuationScope,
          }
        );
      }
    } catch (error) {
      console.warn('[EXCHANGE_PORTFOLIO_REFRESH]', error);
      setWallet((prev) => prev.connectedExchange ? { ...prev, connectedExchange: { ...prev.connectedExchange, portfolioSyncStatus: prev.connectedExchange.portfolioAssets?.length ? 'STALE' : 'ERROR', lastSyncError: error instanceof Error ? error.message.slice(0, 160) : 'Portfolio sync failed' } } : prev);
    } finally {
      finishExchangePortfolioRequest(request.key);
      setIsRefreshingExchange(false);
    }
  };

  // Background polling memakai exchange metadata yang tersimpan; tidak bergantung pada secret di browser.
  useEffect(() => {
    const connected = resolveConnectedExchange();
    if (!currentUser?.uid || !connected) return;

    const refresh = async () => {
      const request = beginExchangePortfolioRequest(connected.exchange, connected.isSandbox);
      if (!request) return;
      try {
        const data = await fetchExchangePortfolio({
          exchange: connected.exchange.toLowerCase(),
          isSandbox: connected.isSandbox,
        });
        if (!data.success) return;
        const candidate = buildPortfolioCandidate(connected.exchange, connected.isSandbox, data);
        const accepted = acceptExchangePortfolioSnapshot(connected.exchange, connected.isSandbox, request.requestSeq, candidate, connected);
        if (!accepted) return;
        const refreshed = {
          ...connected,
          usdtBalance: candidate.usdtBalance,
          usdtAvailable: candidate.usdtAvailable,
          usdtTotalBalance: candidate.usdtTotalBalance,
          totalPortfolioUsdt: candidate.totalPortfolioUsdt,
          rawAssetCount: candidate.rawAssetCount,
          unvaluedDefaultAssetCount: candidate.unvaluedDefaultAssetCount,
          valuationScope: candidate.valuationScope,
          portfolioAssets: candidate.portfolioAssets,
          portfolioAsOf: candidate.portfolioAsOf,
          portfolioSyncStatus: 'LIVE' as const,
          dataSource: 'EXCHANGE_API' as const,
          lastSynced: new Date().toISOString(),
          lastSyncError: undefined,
        };
        setWallet((prev) => {
          if (prev.activeExchange !== connected.exchange) return prev;
          const list = (prev.connectedExchanges || []).map((item) =>
            item.exchange === connected.exchange ? { ...item, ...refreshed, isActive: true } : { ...item, isActive: false }
          );
          return {
            ...prev,
            connectedExchange: refreshed,
            connectedExchanges: list,
            activeExchange: connected.exchange,
            allocatedAssetUsdt: Math.max(0, candidate.totalPortfolioUsdt - candidate.usdtTotalBalance),
          };
        });
      } catch (error) {
        console.warn('[EXCHANGE_PORTFOLIO_POLL]', error);
        setWallet((prev) => prev.activeExchange === connected.exchange && prev.connectedExchange ? { ...prev, connectedExchange: { ...prev.connectedExchange, portfolioSyncStatus: prev.connectedExchange.portfolioAssets?.length ? 'STALE' : 'ERROR', lastSyncError: error instanceof Error ? error.message.slice(0, 160) : 'Portfolio polling failed' } } : prev);
      } finally {
        finishExchangePortfolioRequest(request.key);
      }
    };

    void refresh();
    const interval = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(interval);
  }, [currentUser?.uid, wallet.connectedExchange?.exchange, wallet.connectedExchange?.isSandbox, wallet.connectedExchange?.isConnected]);

  const [isSyncingTrades, setIsSyncingTrades] = useState(false);

  const handleSyncExchangeTrades = async () => {
    const connected = resolveConnectedExchange();
    if (!connected) {
      setIsApiKeyModalOpen(true);
      return;
    }

    setIsSyncingTrades(true);
    try {
      const data = await fetchExchangeTrades({
        exchange: connected.exchange.toLowerCase(),
        isSandbox: connected.isSandbox,
        limit: 100,
      });

      if (data.success && Array.isArray(data.trades) && String(data.exchange || connected.exchange).toLowerCase() === connected.exchange.toLowerCase()) {
        const mappedTrades: TradeRecord[] = data.trades.map((t: any) => ({
          id: `${connected.exchange.toLowerCase()}:${t.id || `${t.symbol}:${t.timestamp}`}`,
          orderId: t.orderId || t.id,
          exchange: t.exchange || connected.exchange,
          symbol: t.symbol,
          side: t.side,
          type: t.type || 'market',
          price: Number(t.price) || 0,
          amount: Number(t.amount) || 0,
          costUsdt: Number(t.costUsdt) || (Number(t.price) || 0) * (Number(t.amount) || 0),
          fee: t.fee,
          realizedPnl: Number.isFinite(Number(t.realizedPnl)) ? Number(t.realizedPnl) : undefined,
          pnlPercent: Number.isFinite(Number(t.pnlPercent)) ? Number(t.pnlPercent) : undefined,
          timestamp: t.timestamp || Date.now(),
          datetime: t.datetime || new Date().toISOString(),
          status: t.status || 'filled',
          isSandbox: t.isSandbox ?? connected.isSandbox,
        }));

        const enrichedTrades = decorateTradesWithRealizedPnl(mappedTrades);
        setTradeHistoryForSource(connected.exchange, connected.isSandbox, enrichedTrades);
        tradeCursorRef.current = enrichedTrades.reduce<number | null>((oldest, trade) => {
          const ts = Number(trade.timestamp || 0);
          if (!Number.isFinite(ts) || ts <= 0) return oldest;
          return oldest === null ? ts : Math.min(oldest, ts);
        }, null);
        setHasMoreTrades(enrichedTrades.length >= 100);
      }
    } catch (err) {
      console.warn('Failed to sync exchange trades:', err);
    } finally {
      setIsSyncingTrades(false);
    }
  };

  // Automatically sync real exchange trades after the connected exchange metadata loads.
  useEffect(() => {
    if (!currentUser?.uid || !wallet.connectedExchange?.isConnected) return;
    void handleSyncExchangeTrades();
    const interval = window.setInterval(() => {
      void handleSyncExchangeTrades();
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [currentUser?.uid, wallet.connectedExchange?.exchange, wallet.connectedExchange?.isSandbox, wallet.connectedExchange?.isConnected]);

  const handleLoadMoreTransactions = async () => {
    if (!currentUser || isLoadingTransactions) return;
    setIsLoadingTransactions(true);
    try {
      const currentCount = transactions ? transactions.length : 0;
      const dbRes = await getUserTransactions({ limit: 50, offset: currentCount }).catch(() => null);

      if (dbRes?.success && Array.isArray(dbRes.transactions) && dbRes.transactions.length > 0) {
        hasLoadedOlderTransactionsRef.current = true;
        setHasMoreTransactions(dbRes.hasMore);
        queryClientInstance.setQueryData<TransactionRecord[]>(transactionsQueryKey, (previous) => {
          const records = new Map((previous || []).map((t) => [t.id, t]));
          dbRes.transactions.forEach((t: any) => records.set(t.id, t));
          return Array.from(records.values()).sort((a, b) => {
            const timeA = Date.parse(a.createdAt || a.timestamp || '') || 0;
            const timeB = Date.parse(b.createdAt || b.timestamp || '') || 0;
            return timeB - timeA;
          });
        });
        return;
      }

      if (transactionCursorRef.current) {
        const page = await fetchOlderUserTransactions(currentUser.uid, transactionCursorRef.current);
        transactionCursorRef.current = page.cursor;
        hasLoadedOlderTransactionsRef.current = true;
        setHasMoreTransactions(page.hasMore);
        queryClientInstance.setQueryData<TransactionRecord[]>(transactionsQueryKey, (previous) => {
          const records = new Map((previous || []).map((t) => [t.id, t]));
          page.items.forEach((t) => records.set(t.id, t));
          return Array.from(records.values()).sort((a, b) => {
            const timeA = Date.parse(a.createdAt || a.timestamp || '') || 0;
            const timeB = Date.parse(b.createdAt || b.timestamp || '') || 0;
            return timeB - timeA;
          });
        });
      } else {
        setHasMoreTransactions(false);
      }
    } catch (error) {
      console.warn('[Transactions] Failed to load older transactions:', error);
    } finally {
      setIsLoadingTransactions(false);
    }
  };

  const handleRefreshTransactions = async () => {
    if (!currentUser || isLoadingTransactions) return;
    setIsLoadingTransactions(true);
    try {
      const dbRes = await getUserTransactions({ limit: 50, offset: 0 });
      if (dbRes?.success && Array.isArray(dbRes.transactions)) {
        queryClientInstance.setQueryData<TransactionRecord[]>(transactionsQueryKey, (previous) => {
          const records = new Map((previous || []).map((t) => [t.id, t]));
          dbRes.transactions.forEach((t: any) => records.set(t.id, t));
          return Array.from(records.values()).sort((a, b) => {
            const timeA = Date.parse(a.createdAt || a.timestamp || '') || 0;
            const timeB = Date.parse(b.createdAt || b.timestamp || '') || 0;
            return timeB - timeA;
          });
        });
      }
    } catch (error) {
      console.warn('[Transactions] Manual refresh failed:', error);
    } finally {
      setIsLoadingTransactions(false);
    }
  };

  const handleLoadMoreTrades = async () => {
    const connected = resolveConnectedExchange();
    const since = tradeCursorRef.current;
    if (!currentUser || !connected || !since || isLoadingTrades || !hasMoreTrades) return;
    setIsLoadingTrades(true);
    try {
      const page = await fetchExchangeTrades({
        exchange: connected.exchange.toLowerCase(),
        isSandbox: connected.isSandbox,
        limit: 100,
        until: Math.max(0, since - 1),
      });
      if (!page?.success || !Array.isArray(page.trades)) {
        setHasMoreTrades(false);
        return;
      }
      const exchangeTrades = decorateTradesWithRealizedPnl(page.trades.map((t: any) => ({
        id: `${connected.exchange.toLowerCase()}:${t.id || `${t.symbol}:${t.timestamp}`}`,
        orderId: t.orderId || t.id,
        exchange: t.exchange || connected.exchange,
        symbol: t.symbol,
        side: t.side,
        type: t.type || 'market',
        price: Number(t.price) || 0,
        amount: Number(t.amount) || 0,
        costUsdt: Number(t.costUsdt) || (Number(t.price) || 0) * (Number(t.amount) || 0),
        fee: t.fee,
        timestamp: Number(t.timestamp || 0),
        datetime: t.datetime || new Date(Number(t.timestamp || Date.now())).toISOString(),
        status: t.status || 'filled',
        isSandbox: t.isSandbox ?? connected.isSandbox,
        realizedPnl: Number.isFinite(Number(t.realizedPnl)) ? Number(t.realizedPnl) : undefined,
        pnlPercent: Number.isFinite(Number(t.pnlPercent)) ? Number(t.pnlPercent) : undefined,
      } as TradeRecord))).filter(
        (trade) => String(trade.exchange || '').toLowerCase() === connected.exchange.toLowerCase()
          && Boolean(trade.isSandbox) === connected.isSandbox
      );
      if (!exchangeTrades.length) {
        setHasMoreTrades(false);
        return;
      }
      setTradeHistoryForSource(connected.exchange, connected.isSandbox, (previous) => {
        const records = new Map((previous as TradeRecord[]).map((trade) => [trade.id, trade]));
        exchangeTrades.forEach((trade) => records.set(trade.id, trade));
        return Array.from(records.values()).sort((a, b) => b.timestamp - a.timestamp);
      });
      const oldest = exchangeTrades.reduce<number | null>((oldestTs, trade) => {
        const ts = Number(trade.timestamp || 0);
        if (!Number.isFinite(ts) || ts <= 0) return oldestTs;
        return oldestTs === null ? ts : Math.min(oldestTs, ts);
      }, null);
      if (oldest === null || oldest >= since) {
        setHasMoreTrades(false);
      } else {
        tradeCursorRef.current = oldest;
        setHasMoreTrades(exchangeTrades.length >= 100);
      }
    } catch (error) {
      console.warn('[EXCHANGE_API] Failed to load older trades:', error);
    } finally {
      setIsLoadingTrades(false);
    }
  };

  // Execute bot order on Exchange Testnet / Live
  const handleExecuteLiveBotOrder = async (
    pair: string = 'BTC/USDT',
    side: 'buy' | 'sell' = 'buy',
    amount?: number
  ) => {
    if (!activeApiCreds) {
      setIsApiKeyModalOpen(true);
      return {
        success: false,
        error: 'API Key belum tersambung di sesi aktif ini. Silakan buka modal API Key dan simpan koneksi.',
      };
    }

    // Gate: Real order execution requires active license
    if (!activeApiCreds.isSandbox && wallet.licenseStatus !== 'active') {
      setIsActivationModalOpen(true);
      return {
        success: false,
        error: 'Eksekusi order ke Bursa Riil terkunci. Akun Anda belum teraktivasi. Silakan bayar biaya aktivasi lisensi untuk trading live di pasar riil.',
      };
    }

    const coinPrice = currentPricesMap[pair];
    const coinRef = positions.find((position) => position.pair === pair);
    if (!coinPrice || !Number.isFinite(coinPrice) || coinPrice <= 0) {
      return { success: false, error: `Harga market real ${pair} belum tersedia dari exchange.` };
    }
    const targetCoin = pair.split('/')[0] || 'BTC';

    const orderAmount =
      amount ||
      (targetCoin === 'BTC'
        ? 0.001
        : targetCoin === 'ETH'
        ? 0.01
        : targetCoin === 'SOL'
        ? 0.1
        : targetCoin === 'BNB'
        ? 0.05
        : targetCoin === 'TAO'
        ? 0.05
        : targetCoin === 'XAUT'
        ? 0.01
        : targetCoin === 'ZEC'
        ? 0.5
        : targetCoin === 'HYPE'
        ? 1.0
        : targetCoin === 'LINK'
        ? 1.5
        : targetCoin === 'AVAX'
        ? 1.0
        : targetCoin === 'NEAR'
        ? 5.0
        : targetCoin === 'SUI'
        ? 10.0
        : targetCoin === 'XRP'
        ? 25.0
        : targetCoin === 'DOGE'
        ? 100.0
        : targetCoin === 'TIA'
        ? 3.0
        : targetCoin === 'ASTER'
        ? 15.0
        : Number((25 / coinPrice).toFixed(3)));

    try {
      const data = await placeExchangeOrder({
          exchange: activeApiCreds.exchange.toLowerCase(),
          symbol: pair,
          side,
          type: 'market',
          amount: orderAmount,
          isSandbox: activeApiCreds.isSandbox,
          accountStatus: wallet.accountStatus,
      });

      if (data.success) {
        // Create Transaction audit
        const newTx: TransactionRecord = {
          id: generateUniqueId('tx-bot'),
          title: `Bot Order ${side.toUpperCase()} ${pair} [${activeApiCreds.isSandbox ? 'Testnet' : 'Live'}]`,
          type: side === 'buy' ? 'outflow' : 'inflow',
          status: 'Completed',
          statusColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
          timestamp: 'Just now',
          counterparty: `${activeApiCreds.exchange} ${activeApiCreds.isSandbox ? 'Testnet' : 'Spot'}`,
          counterpartyLabel: 'Engine: ',
          amount: data.filled ? Number((data.filled * (data.price || 1)).toFixed(2)) : 35,
          amountFormatted: `${data.amount} ${pair.split('/')[0]}`,
          feeInfo: `Order #${data.orderId}`,
          txHash: `0x${data.orderId}`,
          network: `${activeApiCreds.exchange} API`,
        };

        setTransactions((prev) => {
          const map = new Map<string, TransactionRecord>();
          [newTx, ...prev].forEach((item) => {
            if (item?.id && !map.has(item.id)) map.set(item.id, item);
          });
          return Array.from(map.values());
        });

        // Calculate layer execution metrics: Buy price, USD size, estimated TP, floating PnL
        const filledPrice = Number(data.price) || coinPrice;
        const filledAmount = Number(data.filled) || orderAmount;
        const filledCost = Number((filledAmount * filledPrice).toFixed(4));
        const tpPct = 1.5;
        const estimatedTpPrice = Number((filledPrice * (1 + tpPct / 100)).toFixed(4));
        const estimatedTpUsdt = Number((filledCost * (tpPct / 100)).toFixed(4));
        const floatingPnlUsdt = Number(((coinPrice - filledPrice) * filledAmount).toFixed(4));
        const floatingPnlPct = Number((((coinPrice - filledPrice) / filledPrice) * 100).toFixed(2));
        const coinName = pair.split('/')[0] || 'COIN';
        const currentExecutedLayers = Array.isArray(coinRef?.executedLayers) ? coinRef.executedLayers : [];
        const executedStep = Math.min((coinRef?.maxStep || 20), currentExecutedLayers.length + 1);

        const newExecutedLayer: ExecutedLayerDetail = {
          id: generateUniqueId('layer'),
          orderId: data.orderId || generateUniqueId('ord'),
          symbol: pair,
          coin: coinName,
          side,
          layerStep: executedStep,
          layerType: executedStep === 1 ? 'average' : 'grid',
          label: `${side.toUpperCase()} -> ${filledAmount} ${coinName}`,
          amount: filledAmount,
          costUsdt: filledCost,
          buyPrice: filledPrice,
          currentPrice: coinPrice,
          estimatedTpPrice,
          estimatedTpPct: tpPct,
          estimatedTpUsdt,
          floatingPnlUsdt,
          floatingPnlPct,
          fee: 0,
          feeAsset: coinName,
          date: new Date().toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }),
          timestamp: Date.now(),
        };

        const newTradeRecord: TradeRecord = {
          id: data.orderId ? `order-${data.orderId}` : generateUniqueId('trade'),
          orderId: data.orderId,
          exchange: activeApiCreds.exchange,
          symbol: pair,
          side,
          type: 'market',
          price: filledPrice,
          amount: filledAmount,
          costUsdt: filledCost,
          timestamp: Date.now(),
          datetime: new Date().toISOString(),
          status: 'filled',
          strategyName: 'GAIN Layer Averaging Engine',
          layerStep: executedStep,
          isSandbox: activeApiCreds.isSandbox,
          estimatedTpPrice,
          estimatedTpPct: tpPct,
          estimatedTpUsdt,
          currentPrice: coinPrice,
          floatingPnl: floatingPnlUsdt,
          floatingPnlPercent: floatingPnlPct,
        };

        setTradeHistoryForSource(activeApiCreds.exchange, activeApiCreds.isSandbox, (prev) => {
          const map = new Map<string, TradeRecord>();
          [newTradeRecord, ...prev].forEach((item) => {
            if (item?.id && !map.has(item.id)) map.set(item.id, item);
          });
          return Array.from(map.values());
        });

        // Update target position status to active with new executed layer
        setPositions((prev) =>
          prev.map((pos) =>
            pos.pair === pair
              ? {
                  ...pos,
                  status: 'active',
                  statusLabel: 'RUNNING',
                  stepLayer: executedStep,
                  executedLayerCount: (pos.executedLayers?.length || 0) + 1,
                  executedLayers: [newExecutedLayer, ...(pos.executedLayers || [])],
                  allocationUsdt: `${(parseFloat(pos.allocationUsdt) + filledCost).toFixed(2)} USDT`,
                  allocationQty: `${(parseFloat(pos.allocationQty) + filledAmount).toFixed(4)} ${coinName}`,
                }
              : pos
          )
        );

        // Send browser notification & play mechanical audio cue
        notifyLayerExecution({
          pair,
          coin: coinName,
          layerStep: executedStep,
          maxStep: coinRef?.maxStep || 20,
          side,
          price: filledPrice,
          amount: filledAmount,
          costUsdt: filledCost,
          layerType: executedStep === 1 ? 'average' : 'grid',
        });

        // Add to floating in-app notification tray
        addInAppNotification({
          type: 'layer_executed',
          title: `Layer ${executedStep} Tereksekusi: ${pair}`,
          message: `Order ${side.toUpperCase()} ${filledAmount} ${coinName} @ $${formatUsdt(filledPrice)} berhasil diisi (Biaya: $${filledCost.toFixed(2)} USDT).`,
          pair,
          coin: coinName,
          price: filledPrice,
          amount: filledAmount,
          costUsdt: filledCost,
          layerStep: executedStep,
          maxStep: coinRef?.maxStep || 20,
        });


        return {
          success: true,
          orderId: data.orderId,
          message: data.message,
        };
      } else {
        return {
          success: false,
          error: data.error,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Gagal menghubungi server.',
      };
    }
  };

  // Modals
  const isMatrixModalOpen = uiModals.matrix;
  const setIsMatrixModalOpen = (isOpen: boolean) => setUiModalOpen('matrix', isOpen);
  const [selectedPairForMatrix, setSelectedPairForMatrix] = useState('');
  const [selectedPairsForMatrix, setSelectedPairsForMatrix] = useState<string[]>([]);
  const [selectedModeForMatrix, setSelectedModeForMatrix] = useState<BotMode>('Avarage+Grid');
  const [selectedLayersForMatrix, setSelectedLayersForMatrix] = useState<number>(10);
  const [selectedBotIdForMatrix, setSelectedBotIdForMatrix] = useState<string | null>(null);
  const [selectedBotNameForMatrix, setSelectedBotNameForMatrix] = useState<string>('');
  const [selectedMinPriceForMatrix, setSelectedMinPriceForMatrix] = useState<number | null>(null);
  const [selectedMaxPriceForMatrix, setSelectedMaxPriceForMatrix] = useState<number | null>(null);
  const [isNewBotModeForMatrix, setIsNewBotModeForMatrix] = useState<boolean>(true);

  const isDepositModalOpen = uiModals.deposit;
  const setIsDepositModalOpen = (isOpen: boolean) => setUiModalOpen('deposit', isOpen);
  const isWithdrawModalOpen = uiModals.withdraw;
  const setIsWithdrawModalOpen = (isOpen: boolean) => setUiModalOpen('withdraw', isOpen);
  const isTransferModalOpen = uiModals.transfer;
  const setIsTransferModalOpen = (isOpen: boolean) => setUiModalOpen('transfer', isOpen);
  const isGasModalOpen = uiModals.gas;
  const setIsGasModalOpen = (isOpen: boolean) => setUiModalOpen('gas', isOpen);
  const isProfitShareModalOpen = uiModals.profitShare;
  const setIsProfitShareModalOpen = (isOpen: boolean) => setUiModalOpen('profitShare', isOpen);
  const isApiKeyModalOpen = uiModals.apiKey;
  const setIsApiKeyModalOpen = (isOpen: boolean) => setUiModalOpen('apiKey', isOpen);
  const isCoinsCheckerModalOpen = uiModals.coinsChecker;
  const setIsCoinsCheckerModalOpen = (isOpen: boolean) => setUiModalOpen('coinsChecker', isOpen);
  const isActivationModalOpen = uiModals.activation;
  const setIsActivationModalOpen = (isOpen: boolean) => setUiModalOpen('activation', isOpen);
  const is2faModalOpen = uiModals.twoFactor;
  const setIs2faModalOpen = (isOpen: boolean) => setUiModalOpen('twoFactor', isOpen);

  const handleSave2fa = async (enabled: boolean, secret: string, verificationCode: string) => {
    if (!currentUser) throw new Error('Silakan login ulang.');
    await postJson('/api/security/2fa', { enabled, secret, code: verificationCode }, undefined);
    setWallet((prev) => ({ ...prev, twoFactorEnabled: enabled, twoFactorSecret: undefined }));
    reportClientEvent('auth.permission.changed', { enabled });
  };

  const handleEmailVerificationSuccess = async () => {
    setWallet((prev) => ({
      ...prev,
      emailVerified: true,
    }));
  };

  // Secure Account Activation with Backend License Verification
  const handleProcessActivation = async (
    tier: 'starter_6' | 'pro_12' = 'starter_6',
    isUpgrade: boolean = false,
    voucherCode?: string
  ) => {
    const normalizedTier = tier;
    const data = await processWalletActivation({
      userId: currentUser?.uid || wallet.memberId,
      memberId: wallet.memberId,
      tier: normalizedTier,
      isUpgrade,
      voucherCode,
      idempotencyKey: `activation-${normalizedTier}-${currentUser?.uid || wallet.memberId}${voucherCode ? '-' + voucherCode : ''}`,
    });
    if (!data.success) throw new Error(data.error || 'Gagal memproses aktivasi lisensi.');
    reportClientEvent('wallet.activation.completed', { tier: normalizedTier, isUpgrade, voucherCode: voucherCode || '' });
    // PostgreSQL activation is atomic and the server already mirrors both the
    // wallet projection and transaction history. Avoid a second client write.
    return data;
  };

  const handleDepositSuccess = async (amount: number, target: 'gas' | 'vault', txHash: string) => {
    reportClientEvent('wallet.deposit.verified', { target, network: 'BEP-20' });
    void amount;
    void txHash;
    void target;
    void queryClientInstance.invalidateQueries({ queryKey: walletQueryKey });
    void queryClientInstance.invalidateQueries({ queryKey: transactionsQueryKey });
  };

  const handleWithdrawSuccess = async (amount: number, address: string, queueDetails?: any) => {
    reportClientEvent('wallet.withdraw.submitted', { network: 'BEP-20', status: String(queueDetails?.status || 'REVIEW') });
    void amount;
    void address;
    void queryClientInstance.invalidateQueries({ queryKey: walletQueryKey });
    void queryClientInstance.invalidateQueries({ queryKey: transactionsQueryKey });
    return queueDetails;
  };

  const handleTransferSuccess = async (recipientId: string, recipientName: string, amount: number) => {
    reportClientEvent('wallet.transfer.completed', { recipientId });
    void recipientName;
    void amount;
    void queryClientInstance.invalidateQueries({ queryKey: walletQueryKey });
    void queryClientInstance.invalidateQueries({ queryKey: transactionsQueryKey });
    return { success: true };
  };

  const handleTopUpGasSuccess = async (amount: number, bonusAmount: number = 0, isDemoRefill: boolean = false) => {
    if (isDemoRefill) {
      setWallet((prev) => ({ ...prev, gasReserve: Number((prev.gasReserve + amount + bonusAmount).toFixed(4)), nonCashGasBonus: Number(((prev.nonCashGasBonus || 0) + bonusAmount).toFixed(4)) }));
      return;
    }
    setWallet((prev) => ({
      ...prev,
      liquidBalance: Math.max(0, Number((prev.liquidBalance - amount).toFixed(4))),
      gasReserve: Number((prev.gasReserve + amount + bonusAmount).toFixed(4)),
      nonCashGasBonus: Number(((prev.nonCashGasBonus || 0) + bonusAmount).toFixed(4)),
    }));
  };

  // Referral rewards are generated only by authoritative backend financial events.

  const handleForceTakeProfit = async (posIdOrTarget: string | TradingPosition) => {
    const targetObj = typeof posIdOrTarget === 'object' ? posIdOrTarget : null;
    const posId = typeof posIdOrTarget === 'string' ? posIdOrTarget : (posIdOrTarget.id || posIdOrTarget.botId || posIdOrTarget.pair);
    const targetPair = targetObj?.pair || (typeof posIdOrTarget === 'string' ? posIdOrTarget : '');
    const cleanTarget = posId ? posId.replace('/', '').toUpperCase() : '';
    const cleanPair = targetPair ? targetPair.replace('/', '').toUpperCase() : '';

    const isMatch = (p: TradingPosition | BotRuntimeState) => {
      const pId = String(p.id || '').toUpperCase();
      const pBotId = String((p as any).botId || '').toUpperCase();
      const pPair = String(p.pair || '').toUpperCase();
      const pPairClean = pPair.replace('/', '');
      return (
        (posId && (pId === posId.toUpperCase() || pId === cleanTarget)) ||
        (targetPair && (pPairClean === cleanPair || pPair === cleanPair))
      );
    };

    const target = engineBots
      .map((bot) => ({
        id: bot.id,
        botId: bot.botId,
        pair: bot.pair,
        coin: bot.pair.split('/')[0] || bot.pair,
        price: bot.lastPrice,
        avgBuyPrice: bot.avgEntryPrice,
        totalCoinQty: bot.positionQty,
        allocationQty: `${bot.positionQty} ${bot.pair.split('/')[0] || bot.pair}`,
        floatingPnl: (Number(bot.lastPrice) - Number(bot.avgEntryPrice)) * Number(bot.positionQty),
        roiPct: Number(bot.avgEntryPrice) > 0 ? ((Number(bot.lastPrice) - Number(bot.avgEntryPrice)) / Number(bot.avgEntryPrice)) * 100 : 0,
      } as any))
      .find((p) => isMatch(p))
      || positions.find((p) => isMatch(p))
      || (targetObj ? targetObj : null);

    if (!target) return { success: false, error: 'Posisi tidak ditemukan.' };

    const pair = target.pair || targetPair;
    const bot = engineBots.find((item) => isMatch(item as any));

    const botId = bot?.id || target.botId || target.id || pair;
    const quantity = Number(bot?.positionQty ?? target.totalCoinQty ?? parseFloat(target.allocationQty || '0') ?? 0);

    // If active bot runner exists in engine, attempt forceTakeProfit
    if (bot) {
      try {
        const result = await forceTakeProfit(botId, pair, quantity > 0 ? quantity : undefined);
        if (result?.success) {
          const fillPrice = Number(result.fillPrice || target.price || 0);
          const avgEntry = Number(result.avgEntryPrice || target.avgBuyPrice || 0);
          const gross = Math.max(0, (fillPrice - avgEntry) * Number(result.filledQty || quantity));
          notifyTakeProfit({ pair, coin: target.coin || pair.split('/')[0], profitUsdt: gross, roiPct: Number(result.roiPct || 0), exitPrice: fillPrice });
          return { success: true, orderId: result.orderId, isLiveExchange: result.mode === 'live', realizedPnlEstimate: gross, filled: result.filledQty, price: fillPrice };
        }
      } catch (err: any) {
        console.warn('[ForceTP] Engine force TP fallback:', err);
      }
    }

    // Fallback for Standby / Inactive position (0 active bots connected)
    try {
      if (quantity > 0 && wallet.connectedExchange?.isConnected) {
        const orderRes = await handleExecuteLiveBotOrder(pair, 'sell', quantity);
        if (orderRes?.success) {
          await handleDeleteBotPosition(target);
          return { success: true, orderId: orderRes.orderId, message: `Berhasil menjual ${quantity} ${pair} di bursa.` };
        }
      }
      await handleDeleteBotPosition(target);
      return { success: true, message: `Posisi standby ${pair} berhasil dibersihkan.` };
    } catch (err: any) {
      await handleDeleteBotPosition(target);
      return { success: true, message: `Posisi standby ${pair} dibersihkan dari tampilan.` };
    }
  };

  const handleTogglePause = async (posId: string) => {
    // Resolve from backend runtime first. Firestore positions are projections
    // and may be stale/missing after a restart.
    const runtimeById = engineBots.find((bot) => bot.id === posId || bot.botId === posId);
    const targetPos = runtimeById
      ? { id: runtimeById.id, botId: runtimeById.botId, pair: runtimeById.pair, status: runtimeById.status }
      : positions.find((p) => p.id === posId);
    if (!targetPos) return;

    // A paired-coin configuration shares one botId across several runtime
    // runners. Resolve by pair and send the runner id, otherwise every row can
    // resume/pause the first sibling returned by the server.
    const targetBotGroupId = targetPos.botId || targetPos.id;
    const targetRunner = engineBots.find((bot) =>
      bot.pair === targetPos.pair &&
      (bot.botId === targetBotGroupId || bot.id === targetPos.id)
    ) || engineBots.find((bot) => bot.pair === targetPos.pair);
    const targetRunnerId = targetRunner?.id;
    if (!targetRunnerId) {
      showToast(`Runner ${targetPos.pair} belum ditemukan di engine. Muat ulang status bot lalu coba lagi.`, 'error');
      return;
    }

    const willActivate = targetPos.status !== 'active';

    if (willActivate) {
      // Calculate active bots count (unique bot configurations)
      const activeBotIds = new Set(
        positions
          .filter((p) => (p.status === 'active' || p.status === 'averaging') && (p.botId || p.id) !== targetBotGroupId)
          .map((p) => p.botId || p.id)
      );

      const maxAllowed = (isDemoOrTestnet || isAdmin) ? 999999 : (wallet.licenseStatus === 'active' ? (wallet.maxActiveBots || 6) : 6);

      if (activeBotIds.size >= maxAllowed) {
        alert(
          `⚠️ Batas Kuota Bot Aktif Tercapai!\n\n` +
          `Saat ini Anda telah menjalankan ${activeBotIds.size} dari maksimal ${maxAllowed} bot aktif (${wallet.licenseName || 'Starter Lifetime (6 Bot)'}).\n\n` +
          `• Anda bebas menyimpan DRAFT bot tanpa batas.\n` +
          `• Untuk mengaktifkan bot ini secara bersamaan, silakan upgrade ke Paket Pro Lifetime (12 Bot Aktif - $${getLicenseTierConfig('pro_12').promoPriceUsdt} Promo Diskon 50%) atau jeda bot lain yang sedang aktif.`
        );
        setIsActivationModalOpen(true);
        return;
      }
    }

    try {
      const desiredStatus: 'active' | 'paused' = willActivate ? 'active' : 'paused';
      const result = await setBotStatus(targetRunnerId, desiredStatus);

      if (!result?.success) {
        throw new Error(result?.message || 'Perubahan status bot ditolak server.');
      }

      const backendStatus = result.status === 'active' ? 'active' : 'inactive';
      const backendStatusLabel = result.status === 'active' ? 'AKTIF RUNNING' : 'DRAFT / PAUSED';

      setPositions((prev) =>
        prev.map((p) => (
          p.id === posId
            ? { ...p, status: backendStatus, statusLabel: backendStatusLabel }
            : p
        ))
      );

      setEngineBots((prev) =>
        prev.map((bot) => (
          bot.id === (result.runnerId || targetRunnerId)
            ? {
                ...bot,
                status: result.status,
                resumeAfterReconciliation: result.resumeAfterReconciliation === true,
                lastErrorReason: result.lastErrorReason,
              }
            : bot
        ))
      );

      showToast(
        result.status === 'active'
          ? `Bot ${targetPos.pair} berhasil dilanjutkan.`
          : `Bot ${targetPos.pair} berhasil dijeda.`,
        'success'
      );
    } catch (error: any) {
      if (error?.code === 'SESSION_ELEVATION_REQUIRED') {
        // httpClient already emits the security-elevation-required event.
        // The modal is the expected UX, so do not surface a red console error/toast.
        return;
      }
      console.error('[BOT_STATUS_CHANGE_FAILED]', {
        runnerId: targetRunnerId,
        botId: targetBotGroupId,
        pair: targetPos.pair,
        message: error?.message || error,
      });
      showToast(
        error?.message || `Perubahan status bot ${targetPos.pair} gagal. Status backend tidak diubah.`,
        'error'
      );
    }
  };

  const handleBatchForceTp = async () => {
    // Use backend/runtime runners first; Firestore projections may be stale or missing.
    const runtimeCandidates = engineBots.filter((bot) => Number(bot.positionQty || 0) > 0);
    if (runtimeCandidates.length > 0) {
      for (const bot of runtimeCandidates) await handleForceTakeProfit(bot.id);
      return;
    }
    for (const pos of positions.filter((item) => Number(item.totalCoinQty || 0) > 0 || Number(item.floatingPnl || 0) !== 0)) {
      await handleForceTakeProfit(pos.id);
    }
  };

  const handleBatchPauseAll = async () => {
    try {
      const result = await pauseAllBots();
      if (!result?.success) {
        throw new Error(result?.message || 'Perintah Pause All ditolak server.');
      }

      setPositions((prev) =>
        prev.map((p) => ({
          ...p,
          status: 'inactive' as const,
          statusLabel: 'PAUSED',
        }))
      );

      setEngineBots((prev) =>
        prev.map((bot) => ({
          ...bot,
          status: 'paused',
          resumeAfterReconciliation: false,
        }))
      );

      showToast('Seluruh bot berhasil dijeda oleh backend engine.', 'success');
    } catch (error: any) {
      console.error('[BOT_PAUSE_ALL_FAILED]', error);
      showToast(
        error?.message || 'Perintah Pause All gagal. Status backend tidak diubah.',
        'error'
      );
    }
  };

  const handleOpenCustomBot = (
    pair: string = 'BTC/USDT',
    mode?: BotMode,
    layers?: number,
    botId?: string | null,
    botName?: string,
    isNewBot?: boolean,
    minPrice?: number | null,
    maxPrice?: number | null,
    pairedCoins?: string[]
  ) => {
    setSelectedPairForMatrix(pair);
    if (pairedCoins !== undefined) {
      setSelectedPairsForMatrix(pairedCoins);
    } else {
      const existingPos = positions.find((p) => p.id === botId || p.pair === pair);
      if (existingPos?.pairedCoins && existingPos.pairedCoins.length > 0) {
        setSelectedPairsForMatrix(existingPos.pairedCoins);
      } else {
        setSelectedPairsForMatrix(isNewBot ? [] : [pair]);
      }
    }
    if (mode) setSelectedModeForMatrix(mode);
    if (layers) setSelectedLayersForMatrix(layers);
    setSelectedBotIdForMatrix(botId || null);
    setSelectedBotNameForMatrix(botName || '');
    setIsNewBotModeForMatrix(isNewBot ?? (!botId));
    setSelectedMinPriceForMatrix(minPrice !== undefined ? minPrice : null);
    setSelectedMaxPriceForMatrix(maxPrice !== undefined ? maxPrice : null);
    setIsMatrixModalOpen(true);
  };

  const handleDeleteBotPosition = async (target: string | TradingPosition) => {
    if (!target) return;
    const targetObj = typeof target === 'object' ? target : null;
    const posId = typeof target === 'string' ? target : (target.id || target.botId || target.pair);
    const botId = targetObj?.botId;
    const pair = targetObj?.pair || (typeof target === 'string' ? target : '');
    const cleanTarget = posId ? posId.replace('/', '').toUpperCase() : '';
    const cleanPair = pair ? pair.replace('/', '').toUpperCase() : '';
    const cleanBotId = botId ? botId.replace('/', '').toUpperCase() : '';

    const isMatch = (p: any) => {
      const pId = String(p.id || '').toUpperCase();
      const pBotId = String(p.botId || '').toUpperCase();
      const pPair = String(p.pair || '').toUpperCase();
      const pPairClean = pPair.replace('/', '');

      return (
        (posId && (pId === posId.toUpperCase() || pId === cleanTarget || (cleanTarget && pId.startsWith(cleanTarget)))) ||
        (botId && (pBotId === botId.toUpperCase() || pId === cleanBotId || pBotId === cleanBotId || (cleanBotId && pBotId.startsWith(cleanBotId)))) ||
        (cleanPair && (pPairClean === cleanPair || pPair === cleanPair))
      );
    };

    // 1. Immediately purge from local positions state
    setPositions((prev) => prev.filter((p) => !isMatch(p)));

    // 2. Immediately purge from engineBots state so UI updates instantaneously
    setEngineBots((prev) => prev.filter((b) => !isMatch(b)));

    // 3. Purge from positionsByExchange cache map
    setPositionsByExchange((prevMap) => {
      const nextMap = new Map(prevMap);
      for (const [key, list] of nextMap.entries()) {
        nextMap.set(key, list.filter((p) => !isMatch(p)));
      }
      return nextMap;
    });

    // 4. Purge from Firestore & Backend Bot Engine
    if (currentUser?.uid) {
      await deletePositionFromFirestore(currentUser.uid, target);
    }
    try {
      if (botId) await deleteBackgroundBot(botId);
      if (posId && posId !== botId) {
        await deleteBackgroundBot(posId);
      }
    } catch (err) {
      console.warn('[DeleteBot] Warning deleting from backend:', err);
    }
  };

  const handleDeleteAllStandbyBots = async () => {
    const standbyPositions = positions.filter((p) => p.status !== 'active');
    if (standbyPositions.length === 0) return;

    const standbyKeys = new Set(
      standbyPositions.flatMap((p) => [p.id, p.botId]).filter(Boolean)
    );

    // 1. Purge from local state & cache & engineBots
    setPositions((prev) =>
      prev.filter((p) => !standbyKeys.has(p.id) && !standbyKeys.has(p.botId))
    );
    setEngineBots((prev) =>
      prev.filter((b) => !standbyKeys.has(b.id) && !standbyKeys.has(b.botId))
    );
    setPositionsByExchange((prevMap) => {
      const nextMap = new Map(prevMap);
      for (const [key, list] of nextMap.entries()) {
        nextMap.set(
          key,
          list.filter((p) => !standbyKeys.has(p.id) && !standbyKeys.has(p.botId))
        );
      }
      return nextMap;
    });

    // 2. Purge from Firestore and Backend
    if (currentUser?.uid) {
      await Promise.allSettled(
        standbyPositions.map((p) => {
          const idToDelete = p.id || p.botId;
          return idToDelete ? deletePositionFromFirestore(currentUser.uid, idToDelete) : Promise.resolve();
        })
      );
    }
    await Promise.allSettled(
      standbyPositions.map((p) => {
        const idToDelete = p.id || p.botId;
        return idToDelete ? deleteBackgroundBot(idToDelete) : Promise.resolve();
      })
    );
  };

  const handleCloseLayerManual = async (positionId: string, layerId: string) => {
    const targetPos: any = positions.find((p) => p.id === positionId) || engineBots.find((bot) => bot.id === positionId || bot.botId === positionId);
    if (!targetPos) throw new Error('Posisi bot tidak ditemukan.');
    const layers = Array.isArray(targetPos.executedLayers) && targetPos.executedLayers.length > 0
      ? targetPos.executedLayers
      : generateDefaultLayersForPosition(targetPos as TradingPosition);
    const layerToClose = layers.find((layer: any) => layer.id === layerId);
    if (!layerToClose) throw new Error('Layer tidak ditemukan pada projection posisi terbaru.');
    const quantity = Number(layerToClose.amount);
    if (!(quantity > 0)) throw new Error('Jumlah layer tidak valid.');
    const result = await forceTakeProfit(targetPos.botId || targetPos.id, targetPos.pair, quantity, layerId);
    if (!result?.success) throw new Error(result?.error || 'Manual close layer gagal.');

    const fillPrice = Number(result.fillPrice || layerToClose.buyPrice || targetPos.price || 0);
    const filledQty = Number(result.filledQty || quantity);
    const orderId = result.orderId || `manual-${Date.now()}`;
    const costUsdt = Number((filledQty * fillPrice).toFixed(4));
    const grossPnl = (fillPrice - Number(layerToClose.buyPrice || targetPos.avgBuyPrice || 0)) * filledQty;
    const targetExchange = (activeApiCreds?.exchange || targetPos.exchange || currentExchange || 'binance') as ExchangeName;
    const isSandbox = Boolean(targetPos.isSandbox ?? currentExchangeIsSandbox);

    // Record trade into local Trade History cache immediately
    const newTradeRecord: TradeRecord = {
      id: orderId ? `order-${orderId}` : generateUniqueId('trade'),
      orderId,
      exchange: targetExchange,
      symbol: targetPos.pair,
      side: 'sell',
      type: 'market',
      price: fillPrice,
      amount: filledQty,
      costUsdt,
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      status: 'filled',
      strategyName: `GAIN Manual Close (${layerToClose.label || `L${layerToClose.layerStep || ''}`})`,
      layerStep: layerToClose.layerStep,
      isSandbox,
      realizedPnl: grossPnl,
      pnlPercent: Number(result.roiPct || 0),
    };

    setTradeHistoryForSource(targetExchange, isSandbox, (prev) => {
      const map = new Map<string, TradeRecord>();
      [newTradeRecord, ...prev].forEach((item) => {
        if (item?.id && !map.has(item.id)) map.set(item.id, item);
      });
      return Array.from(map.values());
    });

    // Update positions state locally with recalculated layers and average price
    setPositions((prev) =>
      prev.map((pos) => {
        if (pos.id !== targetPos.id && pos.botId !== targetPos.botId && pos.pair !== targetPos.pair) return pos;
        const updatedExecutedLayers = (pos.executedLayers || layers).map((l: any) =>
          l.id === layerId ? { ...l, status: 'closed' } : l
        );
        const activeBuyLayers = updatedExecutedLayers.filter((l: any) => l.side !== 'sell' && l.status !== 'closed');
        const activeQty = activeBuyLayers.reduce((sum: number, l: any) => sum + Number(l.amount || 0), 0);
        const activeCost = activeBuyLayers.reduce((sum: number, l: any) => sum + (Number(l.costUsdt) || (Number(l.buyPrice) * Number(l.amount)) || 0), 0);
        const newAvg = activeQty > 0 ? activeCost / activeQty : 0;
        const closedSet = new Set(pos.closedLayerIds || []);
        closedSet.add(layerId);

        return {
          ...pos,
          executedLayers: updatedExecutedLayers,
          closedLayerIds: Array.from(closedSet),
          stepLayer: Math.max(1, activeBuyLayers.length),
          executedLayerCount: activeBuyLayers.length,
          avgBuyPrice: newAvg > 0 ? newAvg : pos.avgBuyPrice,
          totalCoinQty: activeQty,
          allocationQty: `${activeQty.toFixed(4)} ${pos.coin}`,
          allocationUsdt: `${activeCost.toFixed(2)} USDT`,
          status: activeQty > 1e-8 ? pos.status : 'inactive',
          statusLabel: activeQty > 1e-8 ? pos.statusLabel : 'STANDBY',
        };
      })
    );

    // Sync exchange trades in background
    void handleSyncExchangeTrades().catch(() => {});
    showToast(`Layer ${layerToClose.label || `L${layerToClose.layerStep || ''}`} berhasil ditutup. Riwayat tersimpan.`, 'success');

    reportClientEvent('bot.manual_layer_close.completed', { pair: targetPos.pair, requestedQty: quantity, filledQty: Number(result.filledQty || 0), remainingQty: Number(result.remainingQty || 0) });
    return result;
  };

  const handleDeployBotConfiguration = async (config: {
    botId?: string;
    botName?: string;
    isNewBot?: boolean;
    executionMode: 'testnet' | 'live';
    pair: string;
    pairedCoins?: string[];
    botMode: BotMode;
    layerCount: number;
    initialEntryAmount?: number;
    timeframe?: string;
    baseAmount: number;
    baseTp: number;
    useMoneyManagement?: boolean;
    averageDownPct?: number;
    averagingLayers?: number;
    gridLayers?: number;
    uptrendFilter?: boolean;
    uptrendThresholdPct?: number;
    tpCallbackPct?: number;
    layerCallbackPct?: number;
    gridTp?: number;
    minPrice?: number;
    maxPrice?: number;
    steps?: AveragingStep[];
  }) => {
    if (config.executionMode === 'testnet'
      && (
        currentExchangeConfig?.isConnected !== true ||
        currentExchangeConfig?.isSandbox !== true
      )) {
      showToast('Hubungkan exchange Binance dalam mode Testnet/Sandbox terlebih dahulu.', 'error');
      return;
    }
    if (config.executionMode === 'live'
      && (!activeApiCreds?.apiKey || activeApiCreds.isSandbox || normalizeExchangeName(activeApiCreds.exchange) !== normalizeExchangeName(currentExchange))) {
      showToast('Mode Live memerlukan API key Live exchange yang sedang dipilih.', 'error');
      return;
    }

    const resolvedBotMode = normalizeBotMode(config.botMode);
    const configuredMinPrice = Number(config.minPrice || 0);
    const configuredMaxPrice = Number(config.maxPrice || 0);
    if (configuredMinPrice > 0 && configuredMaxPrice > 0 && configuredMaxPrice <= configuredMinPrice) {
      showToast('Max Price harus lebih tinggi dari Min Price.', 'error');
      return;
    }

    const coinsToDeploy = Array.isArray(config.pairedCoins) && config.pairedCoins.length > 0
      ? config.pairedCoins
      : [config.pair];

    const primaryBotId = config.botId && !config.isNewBot
      ? config.botId
      : `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const finalBotName = config.botName?.trim() || `GAIN Matrix Bot (${coinsToDeploy.length} Koin Terpairing)`;

    const avgL = config.averagingLayers ?? (resolvedBotMode === 'Grid Only' ? 0 : resolvedBotMode === 'Avarage+Grid' ? 20 : config.layerCount);
    const gridL = config.gridLayers ?? (resolvedBotMode === 'Avarage Only' ? 0 : resolvedBotMode === 'Avarage+Grid' ? 100 : config.layerCount);

    // Calculate active bots count excluding current primaryBotId
    const activeBotIds = new Set(
      positions
        .filter((p) => (p.status === 'active' || p.status === 'averaging') && (p.botId || p.id) !== primaryBotId)
        .map((p) => p.botId || p.id)
    );

    const maxAllowed = (isDemoOrTestnet || isAdmin) ? 999999 : (wallet.licenseStatus === 'active' ? (wallet.maxActiveBots || 6) : 6);
    const isOverQuota = activeBotIds.size >= maxAllowed;

    // Circuit Breaker Rule (Zona Kritis: Gas Fee Tank <= 5 USDT)
    // Testnet/Sandbox tidak memakai saldo Gas Tank internal untuk pengujian.
    // Circuit breaker Gas Tank tetap wajib untuk mode Live.
    const isGasCritical =
      config.executionMode === 'live' &&
      wallet.gasReserve <= 5.0;

    let initialStatus: 'active' | 'inactive' = 'active';
    let initialStatusLabel = 'AKTIF RUNNING';

    if (isGasCritical) {
      initialStatus = 'inactive';
      initialStatusLabel = 'AUTO-STANDBY (GAS KRITIS ≤ 5)';
      alert(
        `🚨 ZONA KRITIS AKTIF: Saldo Gas Fee Tank Menipis (${wallet.gasReserve.toFixed(2)} USDT ≤ 5 USDT)!\n\n` +
        `Sesuai aturan keamanan & circuit breaker GAIN:\n` +
        `• Bot baru "${finalBotName}" otomatis disimpan sebagai STANDBY (tidak diizinkan membuka layer averaging baru).\n` +
        `• Posisi floating yang sudah berjalan diberikan masa tenggang (Grace Period) 24 jam untuk menutup siklusnya secara aman.\n` +
        `• Silakan lakukan Top-Up Gas Fee Tank Anda untuk mengaktifkan bot ini kembali.`
      );
      setIsGasModalOpen(true);
    } else if (isOverQuota) {
      initialStatus = 'inactive';
      initialStatusLabel = 'DRAFT (KUOTA PENUH)';
      alert(
        `ℹ️ Bot Disimpan Sebagai DRAFT (Tanpa Batas Kuota Draft)!\n\n` +
        `Saat ini Anda telah menjalankan ${activeBotIds.size}/${maxAllowed} bot aktif (${wallet.licenseName || 'Starter Lifetime (6 Bot)'}).\n\n` +
        `Bot "${finalBotName}" berhasil dibuat dan disimpan ke daftar Bot Anda sebagai DRAFT.\n\n` +
        `• Anda bebas membuat & mengatur DRAFT bot sebanyak mungkin tanpa batas!\n` +
        `• Untuk mengaktifkan bot ini secara bersamaan, silakan upgrade ke Paket Pro Lifetime (12 Bot Aktif - $${getLicenseTierConfig('pro_12').promoPriceUsdt} Promo Diskon 50%) atau jeda bot lain yang sedang aktif.`
      );
    }

    const updatedOrNewPositions: TradingPosition[] = [];
    const initEntryAmt = config.initialEntryAmount ? Math.max(10, config.initialEntryAmount) : 10;
    const selectedTf = config.timeframe || '5m';

    for (const coinPair of coinsToDeploy) {
      const coin = coinPair.split('/')[0] || 'CRYPTO';
      const existingForBotAndCoin = positions.find((p) => p.botId === primaryBotId && p.pair === coinPair) ||
                                    positions.find((p) => p.id === primaryBotId && p.pair === coinPair) ||
                                    (!config.isNewBot ? positions.find((p) => p.pair === coinPair) : null);

      const currentPrice = existingForBotAndCoin?.price || currentPricesMap[coinPair] || 0;
      if (!currentPrice || currentPrice <= 0) {
        showToast(`Harga market real ${coinPair} belum tersedia dari exchange. Bot tidak dibuat.`, 'error');
        return;
      }
      const hasMultiplePairs = coinsToDeploy.length > 1;
      const isPrimaryPair = coinPair === config.pair;
      let minPriceVal = (isPrimaryPair || !hasMultiplePairs) && typeof config.minPrice === 'number' && config.minPrice > 0 ? config.minPrice : (existingForBotAndCoin?.minPrice ?? 0);
      let maxPriceVal = (isPrimaryPair || !hasMultiplePairs) && typeof config.maxPrice === 'number' && config.maxPrice > 0 ? config.maxPrice : (existingForBotAndCoin?.maxPrice ?? 0);
      if (hasMultiplePairs && !isPrimaryPair) {
        minPriceVal = 0;
        maxPriceVal = 0;
      }

      const isAbove = maxPriceVal > 0 && currentPrice > maxPriceVal;
      const isBelow = minPriceVal > 0 && currentPrice < minPriceVal;
      const boundaryStatus = isAbove ? 'ABOVE_MAX' : isBelow ? 'BELOW_MIN' : 'IN_RANGE';

      if (existingForBotAndCoin) {
        const updated: TradingPosition = {
          ...existingForBotAndCoin,
          exchange: currentExchange,
          isSandbox: currentExchangeIsSandbox,
          botId: primaryBotId,
          botName: finalBotName,
          pairedCoins: coinsToDeploy,
          botMode: resolvedBotMode,
          maxStep: Math.max(1, avgL + gridL),
          layerQuota: `1 s/d ${Math.max(1, avgL + gridL)} Layer (${resolvedBotMode})`,
          initialEntryAmount: initEntryAmt,
          initialEntryPrice: existingForBotAndCoin.initialEntryPrice || currentPrice,
          timeframe: selectedTf,
          allocationUsdt: `${(initEntryAmt + config.baseAmount).toFixed(2)} USDT`,
          status: initialStatus,
          statusLabel: initialStatusLabel,
          engine: `${resolvedBotMode} (${avgL > 0 ? `${avgL}L Avg` : ''}${avgL > 0 && gridL > 0 ? ' + ' : ''}${gridL > 0 ? `${gridL}L Grid` : ''}) · 1 Bot ${coinsToDeploy.length} Koin · TF ${selectedTf}`,
          uptrendFilter: config.uptrendFilter ?? true,
          uptrendThresholdPct: config.uptrendThresholdPct ?? 0.1,
          tpCallbackPct: config.tpCallbackPct ?? 0.2,
          layerCallbackPct: config.layerCallbackPct ?? 0.2,
          gridTp: config.gridTp ?? 1.2,
          minPrice: minPriceVal,
          maxPrice: maxPriceVal,
          priceBoundaryStatus: boundaryStatus,
        };
        updatedOrNewPositions.push(updated);
      } else {
        const uniqueId = `pos-${coinPair.replace('/', '').toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const newPos: TradingPosition = {
          id: uniqueId,
          botId: primaryBotId,
          botName: finalBotName,
          pairedCoins: coinsToDeploy,
          pair: coinPair,
          coin,
          status: initialStatus,
          statusLabel: initialStatusLabel,
          price: currentPrice,
          change24h: 1.2,
          engine: `${resolvedBotMode} (${avgL > 0 ? `${avgL}L Avg` : ''}${avgL > 0 && gridL > 0 ? ' + ' : ''}${gridL > 0 ? `${gridL}L Grid` : ''}) · 1 Bot ${coinsToDeploy.length} Koin · TF ${selectedTf}`,
          initialEntryAmount: initEntryAmt,
          initialEntryPrice: currentPrice,
          timeframe: selectedTf,
          allocationUsdt: `${initEntryAmt.toFixed(2)} USDT`,
          allocationQty: `${(initEntryAmt / currentPrice).toFixed(4)} ${coin}`,
          floatingPnl: 0.0,
          roiPct: 0.0,
          stepLayer: 1,
          maxStep: Math.max(1, avgL + gridL),
          layerQuota: `1 s/d ${Math.max(1, avgL + gridL)} Layer`,
          tpTargetPrice: `+${config.baseTp}% Trailing`,
          tpTriggerPrice: `+${config.baseTp}%`,
          nextAveragingTrigger: `-${config.averageDownPct || 1.0}%`,
          trailingProgressPct: 10,
          trailingInfo: `${resolvedBotMode} (${avgL}L Avg + ${gridL}L Grid) Ready · Baseline Marker $${initEntryAmt}`,
          badgeSymbol: coin.slice(0, 3).toUpperCase(),
          logoUrl: `/coins/${coin.toLowerCase()}.svg`,
          badgeBg: 'bg-teal-500/20',
          badgeColor: 'text-teal-400',
          botMode: resolvedBotMode,
          uptrendFilter: config.uptrendFilter ?? true,
          uptrendThresholdPct: config.uptrendThresholdPct ?? 0.1,
          tpCallbackPct: config.tpCallbackPct ?? 0.2,
          layerCallbackPct: config.layerCallbackPct ?? 0.2,
          gridTp: config.gridTp ?? 1.2,
          minPrice: minPriceVal,
          maxPrice: maxPriceVal,
          priceBoundaryStatus: boundaryStatus,
        };
        updatedOrNewPositions.push(newPos);
      }
    }

    // Update local positions state
    setPositions((prev) => {
      const updatedIds = new Set(updatedOrNewPositions.map((p) => p.id));
      const remaining = prev.filter((p) => !updatedIds.has(p.id));
      return [...updatedOrNewPositions, ...remaining];
    });

    // Sync with 24/7 backend background bot runner only if active
    if (initialStatus === 'active') {
      try {
        const registration = await registerBackgroundBot({
            botId: primaryBotId,
            botName: finalBotName,
            pair: coinsToDeploy[0],
            pairedCoins: coinsToDeploy,
            botMode: resolvedBotMode,
            baseAmount: config.baseAmount,
            baseTp: config.baseTp,
            useMoneyManagement: config.useMoneyManagement ?? true,
            availableBalanceUsdt: (typeof wallet.connectedExchange?.usdtBalance === 'number' && wallet.connectedExchange.usdtBalance > 0)
              ? wallet.connectedExchange.usdtBalance
              : (wallet.availableCash || wallet.liquidBalance || 70),
            averagingLayers: avgL,
            gridLayers: gridL,
            uptrendFilter: config.uptrendFilter ?? true,
            uptrendThresholdPct: config.uptrendThresholdPct ?? 0.1,
            tpCallbackPct: config.tpCallbackPct ?? 0.2,
            layerCallbackPct: config.layerCallbackPct ?? 0.2,
            gridTp: config.gridTp ?? 1.2,
            averageDownPct: config.averageDownPct ?? 1.0,
            minPrice: (config.minPrice && config.minPrice > 0) ? config.minPrice : undefined,
            maxPrice: (config.maxPrice && config.maxPrice > 0) ? config.maxPrice : undefined,
            steps: config.steps,
            exchange: currentExchange,
            isSandbox: config.executionMode === 'testnet',
            mode: config.executionMode,
            timeframe: selectedTf,
        });
        if (registration.success !== true) throw new Error('BOT_REGISTRATION_REJECTED');
      } catch (error) {
        let cleanupConfirmed = false;
        try {
          const cleanup = await deleteBackgroundBot(primaryBotId);
          cleanupConfirmed = cleanup.success === true;
        } catch {}

        const standbyPositions = updatedOrNewPositions.map((position) => ({
          ...position,
          status: 'inactive' as const,
          statusLabel: 'STANDBY',
        }));
        const standbyIds = new Set(standbyPositions.map((position) => position.id));
        setPositions((prev) => [
          ...standbyPositions,
          ...prev.filter((position) => !standbyIds.has(position.id)),
        ]);
        const errObj = error as Record<string, unknown>;
        const code = typeof errObj?.code === 'string'
          ? String(errObj.code)
          : 'BOT_REGISTRATION_FAILED';
        const userMsg = typeof errObj?.userMessage === 'string'
          ? errObj.userMessage
          : typeof errObj?.message === 'string'
            ? errObj.message
            : '';
        showToast(
          cleanupConfirmed
            ? `Runner bot gagal didaftarkan (${code}${userMsg ? `: ${userMsg}` : ''}); posisi dikembalikan ke standby.`
            : `Runner bot gagal didaftarkan (${code}${userMsg ? `: ${userMsg}` : ''}) dan pembersihan server belum terkonfirmasi. Periksa status bot sebelum mencoba lagi.`,
          'error'
        );
        setIsMatrixModalOpen(false);
        handleRouteChange('trading');
        return;
      }
    }

    setIsMatrixModalOpen(false);
    handleRouteChange('trading');
  };

  return (
    <div className="min-h-screen bg-[var(--app-background)] text-[var(--app-foreground)] font-sans selection:bg-teal-500 selection:text-white flex flex-col justify-between transition-colors duration-200">
      {/* Top Header */}
      <HeaderBar
        currentExchange={currentExchange}
        onSelectExchange={protectAction(handleSelectActiveExchange)}
        connectedExchange={wallet.connectedExchange}
        connectedExchanges={wallet.connectedExchanges}
        twoFactorEnabled={wallet.twoFactorEnabled !== false}
        onOpenApiKey={protectAction(() => setIsApiKeyModalOpen(true))}
        onDisconnectApi={protectAction(handleDisconnectExchange)}
        onOpenProfitShare={() => setIsProfitShareModalOpen(true)}
        onOpen2faModal={protectAction(() => setIs2faModalOpen(true))}
        onOpenAdmin={() => {
          reportClientEvent('admin.action.attempted', { action: 'open_management' });
          navigate('/admin', { state: { from: location.pathname } });
        }}
        onOpenPriceAlert={protectAction(() => handleOpenPriceAlert())}
        activeAlertsCount={priceAlerts.filter((a) => a.status === 'active').length}
        operationalBots={engineBots}
        onOpenTrading={() => navigate('/bot')}
      />

      {/* Main Content Area: Optimized for Mobile (w-full), Tablet (md:max-w-2xl), Laptop (lg:max-w-4xl), and Desktop (xl:max-w-5xl) */}
      <main className="w-full max-w-xl md:max-w-2xl lg:max-w-4xl xl:max-w-5xl mx-auto px-3 sm:px-5 md:px-6 py-3.5 sm:py-5 flex-1 transition-all duration-200">
        <Suspense fallback={<div className="min-h-[40vh] flex items-center justify-center text-sm text-slate-500" role="status">Memuat halaman...</div>}>
          <Routes>
              <Route path="/" element={
                <HomeView
                  wallet={wallet}
                  positions={positions}
                  engineBots={engineBots}
                  engineStatus={engineStatusState}
                  onOpenDeposit={protectAction(() => setIsDepositModalOpen(true))}
                  onOpenWithdraw={protectAction(() => setIsWithdrawModalOpen(true))}
                  onOpenCustomBot={handleOpenCustomBot}
                  onOpenApiKey={protectAction(() => setIsApiKeyModalOpen(true))}
                  onNavigateTrading={() => navigate('/trading')}
                  onOpenProfitShare={() => setIsProfitShareModalOpen(true)}
                  onOpenTransfer={protectAction(() => setIsTransferModalOpen(true))}
                  onOpenPriceAlert={protectAction(handleOpenPriceAlert)}

                />
              } />
              <Route path="/wallet" element={
                <WalletView
                  wallet={wallet}
                  transactions={transactions}
                  hasMoreTransactions={hasMoreTransactions}
                  isLoadingTransactions={isLoadingTransactions}
                  onLoadMoreTransactions={handleLoadMoreTransactions}
                  onRefreshTransactions={handleRefreshTransactions}
                  positions={positions}
                  engineBots={engineBots}
                  engineStatus={engineStatusState}
                  onOpenDeposit={protectAction(() => setIsDepositModalOpen(true))}
                  onOpenWithdraw={protectAction(() => setIsWithdrawModalOpen(true))}
                  onOpenTransfer={protectAction(() => setIsTransferModalOpen(true))}
                  onOpenGas={protectAction(() => setIsGasModalOpen(true))}
                  onOpenProfitShare={() => setIsProfitShareModalOpen(true)}
                  onOpenApiKey={protectAction(() => setIsApiKeyModalOpen(true))}
                  onOpenActivationModal={protectAction(() => setIsActivationModalOpen(true))}
                  onOpenCoinsChecker={protectAction(() => setIsCoinsCheckerModalOpen(true))}
                  onSelectActiveExchange={protectAction(handleSelectActiveExchange)}
                />
              } />
              <Route path="/trading" element={<Navigate to="/bot" replace />} />
              <Route path="/backtest" element={<BacktestWorkspace onBack={() => navigate('/bot')} />} />
              <Route path="/bot" element={
                <TradingPositionsView
                  positions={positions}
                  engineBots={engineBots}
                  engineStatus={engineStatusState}
                  wallet={wallet}
                  currentExchange={currentExchange}
                  tradeHistory={activeTradeHistory}
                  activeApiCreds={activeApiCreds}
                  isDemoOrTestnet={isDemoOrTestnet}
                  onOpenMatrixModal={handleOpenCustomBot}
                  onDeleteBot={protectAction(handleDeleteBotPosition)}
                  onDeleteAllStandbyBots={protectAction(handleDeleteAllStandbyBots)}
                  onOpenGasModal={protectAction(() => setIsGasModalOpen(true))}
                  onOpenActivationModal={protectAction(() => setIsActivationModalOpen(true))}
                  onForceTakeProfit={protectAction(handleForceTakeProfit)}
                  onTogglePause={protectAction(handleTogglePause)}
                  onReconcileBot={protectAction(handleReconcileBot)}
                  onRebuildBotPosition={protectAction(handleRebuildBotPosition)}
                  onBatchForceTp={protectAction(handleBatchForceTp)}
                  onBatchPauseAll={protectAction(handleBatchPauseAll)}
                  onExecuteBotOrder={protectAction(handleExecuteLiveBotOrder)}
                  onCloseLayer={protectAction(handleCloseLayerManual)}
                  onSyncExchangeTrades={protectAction(handleSyncExchangeTrades)}
                  isSyncingTrades={isSyncingTrades}
                  hasMoreTrades={hasMoreTrades}
                  isLoadingMoreTrades={isLoadingTrades}
                  onLoadMoreTrades={handleLoadMoreTrades}
                  onOpenApiKeyModal={protectAction(() => setIsApiKeyModalOpen(true))}
                  onOpenPriceAlert={protectAction(handleOpenPriceAlert)}
                  onOpenBacktest={() => navigate('/backtest')}
                />
              } />
              <Route path="/akun" element={
                <AccountView
                  wallet={wallet}
                  currentExchange={currentExchange}
                  onOpenApiKey={protectAction(() => setIsApiKeyModalOpen(true))}
                  onDisconnectApi={protectAction(handleDisconnectExchange)}
                  onOpenProfitShare={() => setIsProfitShareModalOpen(true)}
                  onOpenGasModal={protectAction(() => setIsGasModalOpen(true))}
                  onOpenTransfer={protectAction(() => setIsTransferModalOpen(true))}
                  onOpenActivationModal={protectAction(() => setIsActivationModalOpen(true))}
                  onOpen2faModal={protectAction(() => setIs2faModalOpen(true))}
                  onOpenAdmin={() => {
                    reportClientEvent('admin.action.attempted', { action: 'open_management' });
                    navigate('/admin', { state: { from: location.pathname } });
                  }}
                  onSelectActiveExchange={protectAction(handleSelectActiveExchange)}
                  onDisconnectSingleExchange={protectAction(handleDisconnectSingleExchange)}
                />
              } />
              <Route path="/admin" element={
                <RoleRoute>
                  <AdminUserManagementModal
                    isOpen
                    onClose={() => navigate((location.state as { from?: string } | null)?.from || '/akun', { replace: true })}
                  />
                </RoleRoute>
              } />
              <Route path="/moonbot" element={<Navigate to="/bot" replace />} />
              <Route path="/aiotrade" element={<Navigate to="/bot" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      {/* Footer Transparency & Legal Compliance Strip */}
      <footer className="w-full max-w-7xl mx-auto px-4 pb-24 pt-4 text-center">
        <div className="p-3 sm:p-3.5 rounded-2xl bg-[#060D18]/90 border border-[#142338] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-400 font-mono text-[11px] text-left">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              <strong>GAIN (Niaga Koin)</strong> adalah Penyedia Perangkat Lunak Algoritma Trading Otomatis (Trading Software Tool). Bukan pengelola investasi titip dana &amp; Tanpa Bunga/ROI Tetap (No Fixed ROI). Bagi hasil 80:20 murni saat profit riil.
            </span>
          </div>
          <button
            onClick={() => setIsProfitShareModalOpen(true)}
            className="shrink-0 px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:text-white hover:bg-emerald-500/25 text-[11px] font-mono font-bold transition cursor-pointer flex items-center gap-1.5"
          >
            <span>Transparansi 80:20</span>
            <span className="text-[10px]">→</span>
          </button>
        </div>
      </footer>

      {/* Sticky Bottom Dock */}
      <BottomDock
        currentRoute={currentRoute}
        onRouteChange={handleRouteChange}
        activePositionsCount={positions.filter((p) => p.status === 'active').length}
      />

      {/* All Application Modals */}
      <Suspense fallback={null}>
      <LazyMount isOpen={isMatrixModalOpen}>
      <AveragingMatrixModal
        isOpen={isMatrixModalOpen}
        onClose={() => setIsMatrixModalOpen(false)}
        selectedPair={selectedPairForMatrix}
        selectedPairs={selectedPairsForMatrix}
        initialMode={selectedModeForMatrix}
        initialLayers={selectedLayersForMatrix}
        initialAveragingLayers={
          positions.find((p) => p.id === selectedBotIdForMatrix || p.botId === selectedBotIdForMatrix)?.averagingLayers
        }
        initialGridLayers={
          positions.find((p) => p.id === selectedBotIdForMatrix || p.botId === selectedBotIdForMatrix)?.gridLayers
        }
        initialBotId={selectedBotIdForMatrix}
        initialBotName={selectedBotNameForMatrix}
        isNewBot={isNewBotModeForMatrix}
        initialMinPrice={selectedMinPriceForMatrix}
        initialMaxPrice={selectedMaxPriceForMatrix}
        initialInitialEntryAmount={
          positions.find((p) => p.id === selectedBotIdForMatrix)?.initialEntryAmount ?? 10
        }
        initialTimeframe={
          positions.find((p) => p.id === selectedBotIdForMatrix)?.timeframe ?? '5m'
        }
        initialUptrendFilter={
          positions.find((p) => p.id === selectedBotIdForMatrix)?.uptrendFilter ?? true
        }
        initialUptrendThresholdPct={
          positions.find((p) => p.id === selectedBotIdForMatrix)?.uptrendThresholdPct ?? 0.1
        }
        currentMarketPrice={currentPricesMap[selectedPairForMatrix]}
        currentPrices={currentPricesMap}
        existingBotsForCoin={positions.filter(
          (p) => p.pair === selectedPairForMatrix || p.coin === selectedPairForMatrix.split('/')[0]
        )}
        availableBalance={
          currentExchangeConfig?.isConnected
            ? (currentExchangeConfig.usdtBalance ?? 0)
            : (wallet.liquidBalance || 0)
        }
        isTestnetConnected={Boolean(
          (activeApiCreds?.apiKey
            && activeApiCreds.isSandbox
            && normalizeExchangeName(activeApiCreds.exchange) === normalizeExchangeName(currentExchange))
          || (currentExchangeConfig?.isConnected
            && currentExchangeConfig.isSandbox)
        )}
        isLiveConnected={Boolean(
          (activeApiCreds?.apiKey
            && !activeApiCreds.isSandbox
            && normalizeExchangeName(activeApiCreds.exchange) === normalizeExchangeName(currentExchange))
          || (currentExchangeConfig?.isConnected
            && !currentExchangeConfig.isSandbox)
        )}
        onOpenSimulation={() => {
          setIsMatrixModalOpen(false);
          navigate('/backtest');
        }}
        onDeployBot={protectAction(handleDeployBotConfiguration)}
      />
      </LazyMount>

      <LazyMount isOpen={isDepositModalOpen}>
      <DepositModal
        isOpen={isDepositModalOpen}
        onClose={() => setIsDepositModalOpen(false)}
        onViewLedger={() => handleRouteChange('wallet')}
        onDepositSuccess={protectAction(handleDepositSuccess)}
        memberId={wallet.memberId}
        userEmail={wallet.email || currentUser?.email || ''}
      />
      </LazyMount>

      <LazyMount isOpen={isWithdrawModalOpen}>
      <WithdrawModal
        isOpen={isWithdrawModalOpen}
        onClose={() => setIsWithdrawModalOpen(false)}
        availableBalance={wallet.liquidBalance}
        userSecret={wallet.twoFactorSecret}
        userEmail={wallet.email || currentUser?.email || ''}
        memberId={wallet.memberId}
        onWithdrawSuccess={protectAction(handleWithdrawSuccess)}
      />
      </LazyMount>

      <LazyMount isOpen={isTransferModalOpen}>
      <TransferMemberModal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        availableBalance={wallet.liquidBalance}
        userSecret={wallet.twoFactorSecret}
        senderMemberId={wallet.memberId}
        userEmail={wallet.email || currentUser?.email || ''}
        onTransferSuccess={protectAction(handleTransferSuccess)}
      />
      </LazyMount>

      <LazyMount isOpen={is2faModalOpen}>
      <Google2faModal
        isOpen={is2faModalOpen}
        onClose={() => setIs2faModalOpen(false)}
        userEmail={wallet.email}
        username={wallet.username}
        twoFactorEnabled={wallet.twoFactorEnabled !== false}
        twoFactorSecret={wallet.twoFactorSecret}
        onSave2fa={protectAction(handleSave2fa)}
      />
      </LazyMount>

      <LazyMount isOpen={isGasModalOpen}>
      <GasFeeModal
        isOpen={isGasModalOpen}
        onClose={() => setIsGasModalOpen(false)}
        availableBalance={wallet.liquidBalance}
        currentGasReserve={wallet.gasReserve}
        userSecret={wallet.twoFactorSecret}
        memberId={wallet.memberId}
        onTopUpSuccess={protectAction(handleTopUpGasSuccess)}
        onOpenProfitShare={() => {
          setIsGasModalOpen(false);
          setIsProfitShareModalOpen(true);
        }}
        isDemoOrTestnet={isDemoOrTestnet}
      />
      </LazyMount>

      <LazyMount isOpen={isProfitShareModalOpen}>
      <ProfitShareModal
        isOpen={isProfitShareModalOpen}
        onClose={() => setIsProfitShareModalOpen(false)}
        onOpenGasModal={protectAction(() => {
          setIsProfitShareModalOpen(false);
          setIsGasModalOpen(true);
        })}
      />
      </LazyMount>

      <LazyMount isOpen={isApiKeyModalOpen}>
      <ApiKeyModal
        isOpen={isApiKeyModalOpen}
        onClose={() => setIsApiKeyModalOpen(false)}
        currentExchange={currentExchange}
        connectedExchange={wallet.connectedExchange}
        connectedExchanges={wallet.connectedExchanges}
        isAccountActive={wallet.licenseStatus === 'active'}
        onOpenActivationModal={protectAction(() => {
          setIsApiKeyModalOpen(false);
          setIsActivationModalOpen(true);
        })}
        onSelectActiveExchange={protectAction(handleSelectActiveExchange)}
        onDisconnectApi={protectAction(handleDisconnectSingleExchange)}
        onConnectSuccess={protectAction(handleConnectExchangeSuccess)}
      />
      </LazyMount>



      <LazyMount isOpen={isCoinsCheckerModalOpen}>
      <ExchangeCoinsCheckerModal
        isOpen={isCoinsCheckerModalOpen}
        onClose={() => setIsCoinsCheckerModalOpen(false)}
        currentExchange={currentExchange}
        activeApiCreds={activeApiCredsMap.get(currentExchange) || activeApiCreds}
        onSelectExchange={(ex) => {
          setCurrentExchange(ex);
          const creds = activeApiCredsMap.get(ex);
          if (creds) setActiveApiCreds(creds);
        }}
      />
      </LazyMount>

      <LazyMount isOpen={isActivationModalOpen}>
      <ActivationFeeModal
        isOpen={isActivationModalOpen}
        onClose={() => setIsActivationModalOpen(false)}
        wallet={wallet}
        onProcessActivation={protectAction(handleProcessActivation)}
        onOpenDepositModal={protectAction(() => setIsDepositModalOpen(true))}
        activeBotsCount={
          new Set(
            positions
              .filter((p) => p.status === 'active' || p.status === 'averaging')
              .map((p) => p.botId || p.id)
          ).size
        }
      />
      </LazyMount>

      {/* Authentication & Registration Modal (Masuk / Registrasi Akun Baru) */}
      <LazyMount isOpen={isAuthModalOpen}>
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        defaultMode={authModalMode}
        initialSponsorId={pendingSponsorId}
      />
      </LazyMount>

      {/* On-demand security elevation. Protected APIs open this modal only when the
          requested action requires a 24-hour elevated security session. Login itself
          remains Google/Firebase authenticated and is never blocked by this modal. */}
      {isAuthenticatedUser && (
        <LazyMount isOpen={isSecurityVerificationOpen && currentUser?.emailVerified !== false}>
          <SecurityVerificationModal
            isOpen={isSecurityVerificationOpen && currentUser?.emailVerified !== false}
            userEmail={wallet.email || currentUser?.email || ''}
            userName={wallet.username || currentUser?.displayName || ''}
            reason={securityVerificationReason}
            onVerifySuccess={() => {
              setIsSecurityVerificationOpen(false);
              setSecurityVerificationReason('');
              showToast('Sesi keamanan aktif selama 24 jam. Ulangi tindakan yang tadi memerlukan verifikasi.', 'success');
            }}
            onClose={() => {
              setIsSecurityVerificationOpen(false);
              setSecurityVerificationReason('');
            }}
          />
        </LazyMount>
      )}

      {/* User 1/User 2 are now differentiated by license entitlement, not login gates. */}
      {/* User 2 (tanpa lisensi) tetap dapat menggunakan dashboard; User 1 (lisensi aktif)
          mendapatkan fitur berbayar setelah authorization/action checks terpenuhi. */}
      {isAuthenticatedUser && (currentUser?.emailVerified === false) && (
        <LazyMount isOpen>
        <GmailVerificationModal
          isOpen={true}
          userEmail={wallet.email || currentUser?.email || ''}
          userName={wallet.username || currentUser?.displayName || ''}
          onVerificationSuccess={handleEmailVerificationSuccess}
          onCancel={async () => {
            await logout();
          }}
        />
        </LazyMount>
      )}

      {/* Price Alert & Browser Notification System Modal */}
      <LazyMount isOpen={isPriceAlertModalOpen}>
      <PriceAlertModal
        isOpen={isPriceAlertModalOpen}
        onClose={() => setIsPriceAlertModalOpen(false)}
        userId={currentUser?.uid}
        alerts={priceAlerts}
        currentPrices={currentPricesMap}
        initialSymbol={priceAlertSymbol}
      />
      </LazyMount>
      </Suspense>

      {/* Floating In-App & Browser Notification Toasts Container */}
      <NotificationToastContainer
        notifications={inAppNotifications}
        onDismiss={handleDismissNotification}
        onOpenPriceAlertModal={handleOpenPriceAlert}
        browserPermission={browserNotifPerm}
        onRequestPermission={handleRequestBrowserPermission}
      />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AppErrorBoundary>
              <AppContent />
            </AppErrorBoundary>
          </BrowserRouter>
        </QueryClientProvider>
        </AuthProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
