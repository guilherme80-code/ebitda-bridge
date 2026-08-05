import { useGetBridgeComponent, getGetBridgeComponentQueryKey } from '@workspace/api-client-react';
import { X, Layers, Loader2 } from 'lucide-react';
import { formatMUSD, cn } from '../lib/utils';
import { useMemo, useEffect, useState } from 'react';
import type { BridgeDetailLine } from '@workspace/api-client-react';

export function DrillDownDrawer({ 
  componentKey, 
  title,
  source,
  target,
  onClose 
}: { 
  componentKey: string | null; 
  title: string;
  source?: string;
  target?: string;
  onClose: () => void; 
}) {
  const params = source && target ? { source, target } : undefined;
  const { data, isLoading, isError } = useGetBridgeComponent(
    componentKey ?? '',
    params,
    { query: { enabled: !!componentKey, queryKey: getGetBridgeComponentQueryKey(componentKey ?? '', params) } }
  );

  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (componentKey) setIsOpen(true);
    else setIsOpen(false);
  }, [componentKey]);

  const handleClose = () => {
    setIsOpen(false);
    setTimeout(onClose, 300); // Wait for transition out
  };

  const groupedLines = useMemo(() => {
    if (!data?.lines) return {};
    const groups: Record<string, BridgeDetailLine[]> = {};
    data.lines.forEach(line => {
      const g = line.group || 'Geral';
      if (!groups[g]) groups[g] = [];
      groups[g].push(line);
    });
    // Sort lines within groups
    Object.values(groups).forEach(arr => arr.sort((a, b) => a.sortOrder - b.sortOrder));
    return groups;
  }, [data]);

  return (
    <>
      {/* Backdrop */}
      <div 
        className={cn(
          "fixed inset-0 bg-slate-900/30 backdrop-blur-[2px] z-40 transition-opacity duration-300",
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={handleClose}
      />
      
      {/* Drawer */}
      <div 
        className={cn(
          "fixed top-0 right-0 h-full w-full max-w-md bg-white shadow-2xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col border-l border-slate-200",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-8 py-6 border-b border-slate-100 bg-slate-50/50">
          <div>
            <h2 className="text-xl font-bold text-slate-800">{title}</h2>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mt-1.5">Detalhamento do Componente</p>
          </div>
          <button 
            onClick={handleClose}
            className="p-2.5 hover:bg-slate-200 rounded-full transition-colors text-slate-500 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8">
          {isLoading && (
            <div className="flex flex-col items-center justify-center h-40 space-y-4 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
              <p className="text-sm font-medium">Buscando detalhamento...</p>
            </div>
          )}

          {isError && (
            <div className="bg-rose-50 text-rose-600 p-5 rounded-xl text-sm font-medium border border-rose-100">
              Ocorreu um erro ao carregar os detalhes deste componente.
            </div>
          )}

          {data && !isLoading && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {/* Component Summary */}
              <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 flex items-center justify-between shadow-sm">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center border border-slate-200">
                    <Layers className="w-5 h-5 text-slate-600" />
                  </div>
                  <span className="font-bold text-slate-700">Impacto Consolidado</span>
                </div>
                <span className={cn(
                  "text-2xl font-bold tracking-tight",
                  data.value > 0 ? "text-emerald-600" : "text-rose-600"
                )}>
                  {data.value > 0 ? '+' : ''}{formatMUSD(data.value)} <span className="text-sm font-semibold opacity-60 ml-1">{data.unit}</span>
                </span>
              </div>

              {/* Groups */}
              <div className="space-y-8">
                {Object.entries(groupedLines).map(([groupName, lines]) => (
                  <div key={groupName}>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 pb-3 border-b border-slate-100">
                      {groupName}
                    </h3>
                    <div className="space-y-1">
                      {lines.map((line) => (
                        <div
                          key={line.id}
                          className={cn(
                            "py-2.5 px-3 rounded-lg transition-colors group",
                            line.isAdjustment
                              ? "bg-amber-50 border border-amber-200 hover:bg-amber-100/70"
                              : "hover:bg-slate-50",
                          )}
                        >
                          <div className="flex justify-between items-center">
                            <span className="text-[13px] font-semibold text-slate-600 group-hover:text-slate-900 transition-colors flex items-center gap-2">
                              {line.label}
                              {line.isAdjustment && (
                                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
                                  Ajuste gerencial
                                </span>
                              )}
                            </span>
                            <span className={cn(
                              "text-sm font-bold font-mono",
                              line.value > 0 ? "text-emerald-600" : "text-rose-600"
                            )}>
                              {line.value > 0 ? '+' : ''}{formatMUSD(line.value)}
                            </span>
                          </div>
                          {line.isAdjustment && (line.justification || line.responsible || line.status) && (
                            <div className="mt-1.5 text-[12px] text-amber-800/90 space-y-0.5">
                              {line.justification && <p>{line.justification}</p>}
                              <p className="font-semibold">
                                {line.responsible && <>Responsável: {line.responsible}</>}
                                {line.responsible && line.status && ' • '}
                                {line.status && <>Status: {line.status}</>}
                              </p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
