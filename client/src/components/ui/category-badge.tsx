import { Badge } from '@/components/ui/badge';

export function CategoryBadge({ category }: { category?: string }) {
  if (category === 'cfd') return <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">CFD</Badge>;
  if (category === 'etf') return <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">ETF</Badge>;
  return null;
}
