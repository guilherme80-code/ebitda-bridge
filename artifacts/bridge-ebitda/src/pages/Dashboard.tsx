import {
  useGetBridge,
  useGetBridgeSummary,
  useListScenarios,
  useListBridgeExplanations,
  useListMarketExplanations,
  getGetBridgeQueryKey,
  getGetBridgeSummaryQueryKey,
  getListBridgeExplanationsQueryKey,
  getListMarketExplanationsQueryKey,
} from '@workspace/api-client-react';
import type { MarketExplanation } from '@workspace/api-client-react';
import { WaterfallChart } from '../components/WaterfallChart';
import { SummaryCards } from '../components/SummaryCards';
import { DrillDownDrawer } from '../components/DrillDownDrawer';
import { DetailedTables } from '../components/DetailedTables';
import { ScenarioSimulator } from '../components/ScenarioSimulator';
import type { SimulateBridgeResponse } from '@workspace/api-client-react';
import { ScenarioSelector } from '../components/ScenarioSelector';
import { ExplanationsPanel } from '../components/ExplanationsPanel';
import { MarketExplanationDialog } from '../components/MarketExplanationDialog';
import { discrepancyOf } from '../lib/unexplained';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import logoUrl from "@assets/brand/arcelormittal-logo-white.svg";

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
  const sourceSel = catalog?.scenarios.find((s) => s.id === sourceId);
  const targetSel = catalog?.scenarios.find((s) => s.id === targetId);
  const pairAvailable =
    pairSelected &&
    !!sourceSel?.hasData &&
    !!targetSel?.hasData &&
    sourceSel.periodKind === targetSel.periodKind;
  const params = pairSelected
    ? { source: sourceId, target: targetId }
    : undefined;

  const { data: bridge, isLoading: loadingBridge, isError: errorBridge } = useGetBridge(params, {
    query: { enabled: pairAvailable, queryKey: getGetBridgeQueryKey(params) },
  });
  const { data: summary, isLoading: loadingSummary, isError: errorSummary } = useGetBridgeSummary(params, {
    query: { enabled: pairAvailable, queryKey: getGetBridgeSummaryQueryKey(params) },
  });

  // Explicações registradas do par — mesma query do painel abaixo, então
  // adicionar/excluir uma explicação atualiza a coluna "Não Explicado" na hora.
  const { data: explanationsData } = useListBridgeExplanations(params, {
    query: { enabled: pairAvailable, queryKey: getListBridgeExplanationsQueryKey(params) },
  });
  const explainedTotal = explanationsData
    ? explanationsData.explanations.reduce((acc, e) => acc + e.valueMusd, 0)
    : undefined;

  const [selectedComponent, setSelectedComponent] = useState<{key: string, label: string} | null>(null);
  const [simulation, setSimulation] = useState<SimulateBridgeResponse | null>(null);

  // Explicações de mercado (ex.: Iron Ores) importadas para o par — itens
  // vinculados (ex.: Fines, Pellets, Lumps) abrem um pop-up com a tabela.
  const { data: marketData } = useListMarketExplanations(params, {
    query: { enabled: pairAvailable, queryKey: getListMarketExplanationsQueryKey(params) },
  });
  const marketByItem = useMemo(() => {
    const map = new Map<string, MarketExplanation>();
    for (const exp of marketData?.explanations ?? []) {
      for (const item of exp.items) {
        const k = item.trim().toLowerCase();
        if (!map.has(k)) map.set(k, exp);
      }
    }
    return map;
  }, [marketData]);
  const hasMarketExplanation = useCallback(
    (label: string) => marketByItem.has(label.trim().toLowerCase()),
    [marketByItem],
  );
  const [marketPopup, setMarketPopup] = useState<{
    explanation: MarketExplanation;
    itemLabel: string;
  } | null>(null);
  const openMarketItem = useCallback(
    (label: string) => {
      const exp = marketByItem.get(label.trim().toLowerCase());
      if (exp) setMarketPopup({ explanation: exp, itemLabel: label });
    },
    [marketByItem],
  );

  const isLoading = loadingCatalog || (pairSelected && (loadingBridge || loadingSummary));
  const isError = errorCatalog || errorBridge || errorSummary;

  const sourceScenario = catalog?.scenarios.find((s) => s.id === sourceId);
  const targetScenario = catalog?.scenarios.find((s) => s.id === targetId);

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))] flex flex-col font-sans">
      <header className="bg-brand-navy w-full text-white py-8 px-4 md:px-8 border-b-[3px] border-brand-orange shadow-md">
        <div className="max-w-[1400px] mx-auto w-full">
          <div className="mb-6">
            <img src={logoUrl} alt="ArcelorMittal" className="h-8 md:h-10" />
          </div>
          <div className="inline-flex items-center px-2 py-0.5 bg-white/10 text-white text-[10px] font-bold uppercase tracking-widest mb-3 border border-white/20">
            FP&A Executive View
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight font-heading text-white">
            EBITDA Bridge{sourceScenario && targetScenario ? ` — ${sourceScenario.label} vs ${targetScenario.label}` : ''}
          </h1>
          <p className="text-white/80 mt-2 font-medium text-sm md:text-base">
            The variance explains the move from the source scenario to the target scenario • Values expressed in <strong className="text-white">{bridge?.unit || 'MUSD'}</strong>
          </p>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto w-full flex-1 flex flex-col space-y-6 p-4 md:p-8">
        {catalog && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
            <ScenarioSelector
              scenarios={catalog.scenarios}
              sourceId={sourceId}
              targetId={targetId}
              onChange={(s, t) => {
                setSourceId(s);
                setTargetId(t);
                setSimulation(null);
              }}
            />
          </div>
        )}

        {isLoading && (
          <div className="flex-1 flex flex-col items-center justify-center min-h-[500px] text-slate-400 space-y-5">
            <div className="p-4 bg-white rounded-2xl shadow-sm border border-slate-100">
              <Loader2 className="w-10 h-10 animate-spin text-slate-300" />
            </div>
            <p className="font-semibold text-slate-500">Building executive dashboard...</p>
          </div>
        )}

        {isError && !isLoading && (
          <div className="bg-rose-50 border border-rose-100 rounded-2xl p-8 flex flex-col items-center justify-center min-h-[300px] text-rose-600 space-y-4 shadow-sm">
            <div className="p-3 bg-white rounded-xl shadow-sm">
              <AlertCircle className="w-8 h-8 text-rose-500" />
            </div>
            <h2 className="font-bold text-xl text-slate-800">Could not load the data</h2>
            <p className="text-sm font-medium opacity-80 text-center max-w-md">
              Check whether the selected scenario combination has a bridge available, or try refreshing the page.
            </p>
          </div>
        )}

        {!isLoading && !isError && summary && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
            <SummaryCards summary={summary} />
          </div>
        )}

        {!isLoading && !isError && bridge && (
          <ScenarioSimulator
            source={sourceId ?? undefined}
            target={targetId ?? undefined}
            enabled={pairAvailable}
            simulation={simulation}
            onResult={setSimulation}
          />
        )}

        {!isLoading && !isError && bridge && (
          <main className="flex-1 bg-white border border-slate-200 shadow-sm p-3 sm:p-6 flex flex-col animate-in fade-in slide-in-from-bottom-8 duration-700 delay-150 fill-mode-both border-t-4 border-t-brand-navy">
            <div className="mb-8 px-4 pt-4 sm:p-0 flex flex-col sm:flex-row sm:justify-between sm:items-end">
              <div>
                <h2 className="text-xl font-bold text-slate-800 font-heading">
                  EBITDA Variance Composition
                  {simulation && (
                    <span className="ml-3 align-middle text-[10px] font-bold uppercase tracking-widest text-brand-blue bg-blue-50 border border-brand-blue/20 px-2.5 py-1">
                      Simulation
                    </span>
                  )}
                </h2>
                <p className="text-sm font-medium text-slate-500 mt-1">
                  {simulation
                    ? 'Original vs simulated comparison — clear the simulation to return to the original bridge.'
                    : 'Click drivers with breakdowns for a deeper drill-down analysis.'}
                </p>
              </div>
              {!simulation &&
                discrepancyOf(bridge.steps) !== undefined &&
                explainedTotal !== undefined &&
                Math.abs(explainedTotal) > 1e-9 && (
                  <div className="flex items-center gap-4 mt-3 sm:mt-0" data-testid="legend-explained">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                      <span
                        className="w-3 h-3 border border-dashed border-slate-500"
                        style={{
                          backgroundImage:
                            'repeating-linear-gradient(45deg, rgba(100,116,139,0.45) 0 2px, rgba(100,116,139,0.12) 2px 6px)',
                        }}
                      />{' '}
                      Explained
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                      <span className="w-3 h-3 bg-rose-500" /> Unexplained
                    </span>
                  </div>
                )}
              {simulation && (
                <div className="flex items-center gap-4 mt-3 sm:mt-0" data-testid="legend-simulation">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                    <span className="w-3 h-3 bg-slate-400/60" /> Original
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <span className="w-3 h-3 bg-emerald-500" /> Simulated
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-blue">
                    <span className="w-3 h-3 border-2 border-brand-blue bg-white" /> Adjusted
                  </span>
                </div>
              )}
            </div>
            <div className="w-full h-[480px]">
              <WaterfallChart 
                steps={simulation ? simulation.steps : bridge.steps} 
                baseSteps={simulation ? bridge.steps : undefined}
                explainedTotal={explainedTotal}
                onBarClick={(step) => {
                  if (step.hasDetail && !simulation) setSelectedComponent({ key: step.key, label: step.label });
                }}
              />
            </div>
          </main>
        )}

        {/* Painel de explicações: só quando o bridge NÃO fecha pela fonte
            (o servidor incluiu o passo "Não Explicado"). */}
        {!isLoading && !isError && bridge && discrepancyOf(bridge.steps) !== undefined && (
          <ExplanationsPanel
            sourceId={sourceId}
            targetId={targetId}
            enabled={pairAvailable}
            residual={discrepancyOf(bridge.steps)}
          />
        )}

        {!isLoading && !isError && bridge && (
          <DetailedTables
            params={params}
            enabled={pairAvailable}
            simulatedTables={simulation?.tables}
            hasMarketExplanation={hasMarketExplanation}
            onMarketItemClick={openMarketItem}
          />
        )}
      </div>

      <DrillDownDrawer 
        componentKey={selectedComponent?.key ?? null}
        title={selectedComponent?.label ?? ''}
        source={sourceId ?? undefined}
        target={targetId ?? undefined}
        onClose={() => setSelectedComponent(null)}
        hasMarketExplanation={hasMarketExplanation}
        onMarketItemClick={openMarketItem}
      />

      <MarketExplanationDialog
        explanation={marketPopup?.explanation ?? null}
        itemLabel={marketPopup?.itemLabel ?? null}
        sourceLabel={sourceScenario?.label}
        targetLabel={targetScenario?.label}
        onClose={() => setMarketPopup(null)}
      />
    </div>
  )
}
