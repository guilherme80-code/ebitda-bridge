import {
  useGetBridgeTables,
  getGetBridgeTablesQueryKey,
  type GetBridgeTablesParams,
  type SimulatedBridgeTable,
} from '@workspace/api-client-react';
import { Table2 } from 'lucide-react';

const nf = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function fmt(v: number | null): string {
  if (v == null) return '—';
  if (Math.abs(v) < 0.05) return '0,0';
  return nf.format(v);
}

interface Props {
  params?: GetBridgeTablesParams;
  enabled: boolean;
  /** Tabelas simuladas (com valores originais e células ajustadas). */
  simulatedTables?: SimulatedBridgeTable[];
}

export function DetailedTables({ params, enabled, simulatedTables }: Props) {
  const { data, isLoading, isError } = useGetBridgeTables(params, {
    query: { enabled, queryKey: getGetBridgeTablesQueryKey(params) },
  });

  const simulating = !!simulatedTables && simulatedTables.length > 0;

  if (!enabled) return null;
  if (!simulating && (isLoading || isError || !data)) return null;

  const tables = simulating ? simulatedTables! : data!.tables;

  return (
    <section className="space-y-6 animate-in fade-in slide-in-from-bottom-8 duration-700 fill-mode-both">
      <div className="px-1">
        <h2 className="text-xl font-bold font-heading text-slate-800 flex items-center gap-2">
          <Table2 className="w-5 h-5 text-slate-400" />
          Tabelas detalhadas por alavanca
          {simulating && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand-blue bg-blue-50 border border-brand-blue/20 px-2.5 py-1">
              Simulação
            </span>
          )}
        </h2>
        <p className="text-sm font-medium text-slate-500 mt-1">
          {simulating
            ? 'Valores simulados — as células ajustadas aparecem destacadas com o valor original ("antes") logo abaixo.'
            : 'Aberturas equivalentes às abas da planilha (Receita, Custo fixo, Insumos, Consumo, Câmbio, Estoque/Outros).'}
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {tables.map((table) => (
        <div
          key={table.key}
          className={`bg-white border shadow-sm overflow-hidden ${
            simulating ? 'border-brand-blue/40' : 'border-slate-200'
          } ${table.key === 'sales' ? 'xl:col-span-2' : ''}`}
        >
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
            <h3 className="font-bold text-slate-800 font-heading">{table.title}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid={`table-${table.key}`}>
              <thead>
                <tr className="bg-slate-50 text-slate-500">
                  <th className="text-left font-semibold px-5 py-2.5 whitespace-nowrap sticky left-0 bg-slate-50">
                    Linha
                  </th>
                  {table.columns.map((c) => (
                    <th key={c.key} className="text-right font-semibold px-4 py-2.5 whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => {
                  const strong = row.kind !== 'row';
                  const simRow = simulating ? (row as SimulatedBridgeTable['rows'][number]) : null;
                  const rowChanged = simRow?.changed.some(Boolean) ?? false;
                  return (
                    <tr
                      key={`${row.label}-${i}`}
                      data-testid={rowChanged ? `row-adjusted-${table.key}-${i}` : undefined}
                      className={
                        strong
                          ? row.kind === 'total'
                            ? 'bg-slate-100/80 font-bold text-slate-900 border-t-2 border-slate-200'
                            : 'bg-slate-50/70 font-semibold text-slate-700 border-t border-slate-200'
                          : rowChanged
                            ? 'border-t border-brand-blue/20 bg-blue-50/40 text-slate-700'
                            : 'border-t border-slate-100 text-slate-600 hover:bg-slate-50/50'
                      }
                    >
                      <td className="px-5 py-2 whitespace-nowrap sticky left-0 bg-inherit">
                        {row.label}
                        {rowChanged && row.kind === 'row' && (
                          <span className="ml-2 align-middle text-[9px] font-bold uppercase tracking-widest text-brand-blue bg-blue-100/80 px-1.5 py-0.5 border border-brand-blue/10">
                            Ajustado
                          </span>
                        )}
                      </td>
                      {row.values.map((v, j) => {
                        const isEffect = /MUSD/.test(table.columns[j]?.label ?? '');
                        const colored =
                          isEffect && v != null && Math.abs(v) >= 0.05 && /efeito|Vol & Mix|Preço \(|Câmbio \(/i.test(table.columns[j]?.label ?? '');
                        const cellChanged = simRow?.changed[j] ?? false;
                        const baseV = simRow?.baseValues[j] ?? null;
                        return (
                          <td
                            key={j}
                            className={`px-4 py-2 text-right tabular-nums whitespace-nowrap align-top ${
                              cellChanged ? 'bg-blue-50/80' : ''
                            } ${colored ? (v! > 0 ? 'text-emerald-600' : 'text-rose-600') : ''}`}
                          >
                            <span className={cellChanged ? 'font-bold text-brand-blue' : ''}>
                              {fmt(v)}
                            </span>
                            {cellChanged && (
                              <span className="block text-[10px] font-medium text-slate-400">
                                antes: {fmt(baseV)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      </div>
    </section>
  );
}
