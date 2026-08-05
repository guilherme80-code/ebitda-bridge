import {
  useGetBridgeTables,
  getGetBridgeTablesQueryKey,
  type GetBridgeTablesParams,
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
}

export function DetailedTables({ params, enabled }: Props) {
  const { data, isLoading, isError } = useGetBridgeTables(params, {
    query: { enabled, queryKey: getGetBridgeTablesQueryKey(params) },
  });

  if (!enabled || isLoading || isError || !data) return null;

  return (
    <section className="space-y-6 animate-in fade-in slide-in-from-bottom-8 duration-700 fill-mode-both">
      <div className="px-1">
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <Table2 className="w-5 h-5 text-slate-400" />
          Tabelas detalhadas por alavanca
        </h2>
        <p className="text-sm font-medium text-slate-500 mt-1">
          Aberturas equivalentes às abas da planilha (Receita, Custo fixo, Insumos, Consumo, Câmbio, Estoque/Outros).
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {data.tables.map((table) => (
        <div
          key={table.key}
          className={`bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden ${
            table.key === 'sales' ? 'xl:col-span-2' : ''
          }`}
        >
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="font-bold text-slate-800">{table.title}</h3>
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
                  return (
                    <tr
                      key={`${row.label}-${i}`}
                      className={
                        strong
                          ? row.kind === 'total'
                            ? 'bg-slate-100/80 font-bold text-slate-900 border-t-2 border-slate-200'
                            : 'bg-slate-50/70 font-semibold text-slate-700 border-t border-slate-200'
                          : 'border-t border-slate-100 text-slate-600 hover:bg-slate-50/50'
                      }
                    >
                      <td className="px-5 py-2 whitespace-nowrap sticky left-0 bg-inherit">
                        {row.label}
                      </td>
                      {row.values.map((v, j) => {
                        const isEffect = /MUSD/.test(table.columns[j]?.label ?? '');
                        const colored =
                          isEffect && v != null && Math.abs(v) >= 0.05 && /efeito|Vol & Mix|Preço \(|Câmbio \(/i.test(table.columns[j]?.label ?? '');
                        return (
                          <td
                            key={j}
                            className={`px-4 py-2 text-right tabular-nums whitespace-nowrap ${
                              colored ? (v! > 0 ? 'text-emerald-600' : 'text-rose-600') : ''
                            }`}
                          >
                            {fmt(v)}
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
