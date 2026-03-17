import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';

interface TickerResult {
  symbol: string;
  name: string;
  exchange: string;
  currency?: string;
}

interface TickerAutocompleteProps {
  value: string;
  onChange: (value: string, result?: TickerResult) => void;
  placeholder?: string;
  className?: string;
}

export function TickerAutocomplete({ value, onChange, placeholder = 'Wpisz ticker...', className }: TickerAutocompleteProps) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<TickerResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Sync external value
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const search = useCallback(async (q: string) => {
    if (q.length < 1) {
      setResults([]);
      setIsOpen(false);
      return;
    }
    setIsLoading(true);
    try {
      const data = await api.searchTickers(q);
      const list = Array.isArray(data) ? data : [];
      setResults(list);
      setIsOpen(list.length > 0);
      setHighlightIndex(-1);
    } catch {
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setQuery(val);
    onChange(val);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 300);
  };

  const handleSelect = (result: TickerResult) => {
    setQuery(result.symbol);
    onChange(result.symbol, result);
    setIsOpen(false);
    setResults([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(prev => (prev + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(prev => (prev - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      handleSelect(results[highlightIndex]);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className={`relative ${className || ''}`}>
      <Input
        value={query}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setIsOpen(true); }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {isLoading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          ...
        </div>
      )}
      {isOpen && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-md border bg-popover shadow-lg">
          {results.map((r, i) => (
            <button
              key={`${r.symbol}-${r.exchange}`}
              type="button"
              className={`w-full text-left px-3 py-2 text-sm hover:bg-accent cursor-pointer flex items-center justify-between gap-2 ${
                i === highlightIndex ? 'bg-accent' : ''
              }`}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <div className="flex flex-col min-w-0">
                <span className="font-medium truncate">{r.symbol}</span>
                <span className="text-xs text-muted-foreground truncate">{r.name}</span>
              </div>
              <div className="flex flex-col items-end shrink-0">
                <span className="text-xs text-muted-foreground">{r.exchange}</span>
                {r.currency && <span className="text-xs text-muted-foreground">{r.currency}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
