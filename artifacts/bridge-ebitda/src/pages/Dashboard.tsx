import {
  useGetBridge,
  useGetBridgeSummary,
  useListScenarios,
  getGetBridgeQueryKey,
  getGetBridgeSummaryQueryKey,
} from '@workspace/api-client-react';
import { WaterfallChart } from '../components/WaterfallChart';
import { SummaryCards } from '../components/SummaryCards';
import { DrillDownDrawer } from '../components/DrillDownDrawer';
import { ScenarioSelector } from '../components/ScenarioSelector';
import { useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';

export default function Dashboard() {
  const { data: catalog, isLoading: loadingCatalog, isError: errorCatalog } = useListScenarios();

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (catalog && (!sourceId || !targetId)) {
      setSourceId(catalog.defaultPair.sourceId);
      setTargetId(catalog.defaultPair.targetId);
    }
  }, [catalog, sourceId, targetId]);

  const pairSelected = !!sourceId && !!targetId;
  const pairAvailable =
    pairSelected &&
    !!catalog?.pairs.some((p) => p.sourceId === sourceId && p.targetId === targetId);
  const params = pairSelected
    ? { source: sourceId, target: targetId }
    : undefined;

  const { data: bridge, isLoading: loadingBridge, isError: errorBridge } = useGetBridge(params, {
    query: { enabled: pairAvailable, queryKey: getGetBridgeQueryKey(params) },
  });
  const { data: summary, isLoading: loadingSummary, isError: errorSummary } = useGetBridgeSummary(params, {
    query: { enabled: pairAvailable, queryKey: getGetBridgeSummaryQueryKey(params) },
  });

  const [selectedComponent, setSelectedComponent] = useState<{key: string, label: string} | null>(null);

  const isLoading = loadingCatalog || (pairSelected && (loadingBridge || loadingSummary));
  const isError = errorCatalog || errorBridge || errorSummary;

  const sourceScenario = catalog?.scenarios.find((s) => s.id === sourceId);
  const targetScenario = catalog?.scenarios.find((s) => s.id === targetId);

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))] p-4 md:p-8 flex flex-col font-sans">
      <header className="mb-6 max-w-[1400px] mx-auto w-full">
        <div className="inline-flex items-center px-3 py-1 rounded-full bg-slate-200/50 text-slate-600 text-[10px] font-bold uppercase tracking-widest mb-4">
          FP&A Executive View
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-[hsl(var(--foreground))]">
          Bridge de EBITDA{sourceScenario && targetScenario ? ` — ${sourceScenario.label} vs ${targetScenario.label}` : ''}
        </h1>
        <p className="text-[hsl(var(--muted-foreground))] mt-2 font-medium text-sm md:text-base">
          A variação explica a passagem do cenário de origem para o cenário de destino • Valores expressos em <strong className="text-slate-700">{bridge?.unit || 'MUSD'}</strong>
        </p>
      </header>

      <div className="max-w-[1400px] mx-auto w-full flex-1 flex flex-col space-y-6">
        {catalog && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
            <ScenarioSelector
              scenarios={catalog.scenarios}
              pairs={catalog.pairs}
              sourceId={sourceId}
              targetId={targetId}
              onChange={(s, t) => {
                setSourceId(s);
                setTargetId(t);
              }}
            />
          </div>
        )}

        {isLoading && (
          <div className="flex-1 flex flex-col items-center justify-center min-h-[500px] text-slate-400 space-y-5">
            <div className="p-4 bg-white rounded-2xl shadow-sm border border-slate-100">
              <Loader2 className="w-10 h-10 animate-spin text-slate-300" />
            </div>
            <p className="font-semibold text-slate-500">Construindo painel executivo...</p>
          </div>
        )}

        {isError && !isLoading && (
          <div className="bg-rose-50 border border-rose-100 rounded-2xl p-8 flex flex-col items-center justify-center min-h-[300px] text-rose-600 space-y-4 shadow-sm">
            <div className="p-3 bg-white rounded-xl shadow-sm">
              <AlertCircle className="w-8 h-8 text-rose-500" />
            </div>
            <h2 className="font-bold text-xl text-slate-800">Não foi possível carregar os dados</h2>
            <p className="text-sm font-medium opacity-80 text-center max-w-md">
              Verifique se a combinação de cenários selecionada possui bridge disponível, ou tente atualizar a página.
            </p>
          </div>
        )}

        {!isLoading && !isError && summary && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
            <SummaryCards summary={summary} />
          </div>
        )}

        {!isLoading && !isError && bridge && (
          <main className="flex-1 bg-white rounded-2xl border border-slate-200 shadow-sm p-3 sm:p-6 flex flex-col animate-in fade-in slide-in-from-bottom-8 duration-700 delay-150 fill-mode-both">
            <div className="mb-8 px-4 pt-4 sm:p-0 flex flex-col sm:flex-row sm:justify-between sm:items-end">
              <div>
                <h2 className="text-xl font-bold text-slate-800">Composição da Variação de EBITDA</h2>
                <p className="text-sm font-medium text-slate-500 mt-1">Clique nas alavancas com detalhamento para análise aprofundada (drill-down).</p>
              </div>
            </div>
            <div className="w-full h-[480px]">
              <WaterfallChart 
                steps={bridge.steps} 
                onBarClick={(step) => {
                  if (step.hasDetail) setSelectedComponent({ key: step.key, label: step.label });
                }}
              />
            </div>
          </main>
        )}
      </div>

      <DrillDownDrawer 
        componentKey={selectedComponent?.key ?? null}
        title={selectedComponent?.label ?? ''}
        source={sourceId ?? undefined}
        target={targetId ?? undefined}
        onClose={() => setSelectedComponent(null)}
      />
    </div>
  )
}
