import React, { useState, useRef, useEffect } from 'react';
import { useLanguage, APP_LANGUAGES, type AppLanguage } from '../../context/LanguageContext';
import { Check, Globe, ChevronDown } from 'lucide-react';

interface LanguageSelectorProps {
  variant?: 'header' | 'pill' | 'minimal' | 'full';
  className?: string;
}

export function LanguageSelector({ variant = 'header', className = '' }: LanguageSelectorProps) {
  const { language, setLanguage, t } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentLang = APP_LANGUAGES.find((item) => item.id === language) || APP_LANGUAGES[0];

  // Close dropdown on click outside or Escape key press
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (langId: AppLanguage) => {
    setLanguage(langId);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative inline-block text-left ${className}`}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('selectLanguage') || 'Pilih Bahasa'}
        className={`flex items-center gap-1.5 rounded-full transition-all cursor-pointer font-medium select-none ${
          variant === 'header'
            ? 'h-9 px-2.5 bg-slate-100 dark:bg-[#111C2E] border border-slate-200 dark:border-[#1E2E44] text-slate-700 dark:text-slate-200 hover:border-[#8DC63F]/50 dark:hover:border-[#8DC63F]/50 text-xs'
            : variant === 'pill'
            ? 'px-2.5 py-1 bg-slate-100 dark:bg-[#0B1424] border border-slate-200 dark:border-[#162740] text-slate-700 dark:text-slate-300 text-[11px]'
            : 'px-3 py-1.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs'
        }`}
      >
        <span className="text-sm leading-none">{currentLang.flag}</span>
        <span className="hidden sm:block font-medium tracking-tight truncate max-w-[90px]">{currentLang.nativeLabel}</span>
        <ChevronDown className={`hidden sm:block w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Popover Dropdown Menu (Matches UI Design in Screenshot) */}
      {isOpen && (
        <div
          role="listbox"
          aria-label={t('selectLanguage') || 'Pilih Bahasa'}
          className="absolute right-0 mt-2 w-48 rounded-2xl bg-[#141C2B]/95 dark:bg-[#111827]/98 border border-slate-700/60 dark:border-slate-800 backdrop-blur-xl shadow-2xl shadow-black/50 p-1.5 z-50 animate-in fade-in zoom-in-95 duration-150"
        >
          <div className="py-0.5 space-y-0.5">
            {APP_LANGUAGES.map((item) => {
              const isSelected = item.id === language;
              return (
                <button
                  key={item.id}
                  role="option"
                  aria-selected={isSelected}
                  type="button"
                  onClick={() => handleSelect(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer text-left ${
                    isSelected
                      ? 'bg-slate-800/90 text-white font-semibold'
                      : 'text-slate-200 hover:bg-slate-800/60 hover:text-white'
                  }`}
                >
                  <div className="w-4 flex items-center justify-center shrink-0">
                    {isSelected ? (
                      <Check className="w-4 h-4 text-emerald-400 stroke-[2.5]" />
                    ) : (
                      <span className="w-4" />
                    )}
                  </div>
                  <span className="text-sm shrink-0">{item.flag}</span>
                  <span className="truncate">{item.nativeLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
