import { NavigationRoute } from '../types';
import { useLanguage } from '../context/LanguageContext';
import { Home, Wallet, Bot, LineChart, User } from 'lucide-react';

interface BottomDockProps {
  currentRoute: NavigationRoute;
  onRouteChange: (route: NavigationRoute) => void;
  activePositionsCount?: number;
}

export function BottomDock({ currentRoute, onRouteChange, activePositionsCount = 6 }: BottomDockProps) {
  const { t } = useLanguage();
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-[#070C15]/95 border-t border-slate-200 dark:border-[#121E31] backdrop-blur-lg px-1 sm:px-6 py-1.5 sm:py-2 shadow-[0_-4px_16px_rgba(15,23,42,0.06)] dark:shadow-none">
      <div className="max-w-xl mx-auto flex items-center justify-between">
        {/* Home */}
        <button
          onClick={() => onRouteChange('home')}
          className={`flex-1 flex flex-col items-center py-1 transition-all cursor-pointer ${
            currentRoute === 'home' ? 'text-emerald-600 dark:text-[#8DC63F] font-bold' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Home className="w-5 h-5 mb-1" />
          <span className="text-[10px] font-medium tracking-wide">{t('home')}</span>
          {currentRoute === 'home' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-[#8DC63F] mt-0.5"></span>}
        </button>

        {/* Wallet */}
        <button
          onClick={() => onRouteChange('wallet')}
          className={`flex-1 flex flex-col items-center py-1 transition-all relative cursor-pointer ${
            currentRoute === 'wallet' ? 'text-emerald-600 dark:text-[#8DC63F] font-bold' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Wallet className="w-5 h-5 mb-1" />
          <span className="text-[10px] font-medium tracking-wide">{t('wallet')}</span>
          {currentRoute === 'wallet' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-[#8DC63F] mt-0.5"></span>}
        </button>

        {/* Center: Semua Bot */}
        <div className="flex-1 flex flex-col items-center">
          <button
            onClick={() => onRouteChange('bot')}
            className={`w-11 h-11 -mt-4 rounded-2xl flex items-center justify-center transition-all active:scale-95 shadow-md cursor-pointer ${
              currentRoute === 'bot'
                ? 'bg-[#8DC63F] text-slate-950 shadow-[0_4px_20px_rgba(141,198,63,0.4)] font-bold'
                : 'bg-white dark:bg-[#141E2E] text-emerald-600 dark:text-[#8DC63F] border border-emerald-500/40 dark:border-[#8DC63F]/40 hover:border-emerald-500 shadow-sm'
            }`}
            title={t('bot')}
          >
            <Bot className="w-5 h-5" />
          </button>
          <span className={`text-[9.5px] font-semibold mt-1 ${currentRoute === 'bot' ? 'text-emerald-600 dark:text-[#8DC63F]' : 'text-slate-500 dark:text-slate-400'}`}>
            {t('bot')}
          </span>
        </div>

        {/* Akun */}
        <button
          onClick={() => onRouteChange('akun')}
          className={`flex-1 flex flex-col items-center py-1 transition-all cursor-pointer ${
            currentRoute === 'akun' ? 'text-emerald-600 dark:text-[#8DC63F] font-bold' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <User className="w-5 h-5 mb-1" />
          <span className="text-[10px] font-medium tracking-wide">{t('account')}</span>
          {currentRoute === 'akun' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-[#8DC63F] mt-0.5"></span>}
        </button>
      </div>
    </nav>
  );
}
