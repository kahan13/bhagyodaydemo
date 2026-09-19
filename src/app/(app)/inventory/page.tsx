'use client';

import React, { useState, useEffect, useMemo } from 'react';

interface InventoryItem {
  id: string;
  sku: string;
  current_stock: number;
  custom_attributes?: Record<string, any>;
}

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [columns, setColumns] = useState<{ key: string; header: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  
  // Excel-like column widths (resizable state)
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    sku: 220,
    stock: 120,
  });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [startX, setStartX] = useState(0);
  const [startWidth, setStartWidth] = useState(0);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        const [colRes, prodRes] = await fetchAll();
        if (colRes?.columns) {
          setColumns(colRes.columns);
          const initialWidths: Record<string, number> = { sku: 220, stock: 120 };
          colRes.columns.forEach((c: { key: string }) => {
            initialWidths[c.key] = 180;
          });
          setColWidths((prev) => ({ ...initialWidths, ...prev }));
        }
        if (prodRes?.products) {
          setItems(prodRes.products);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  async function fetchAll() {
    const [c, p] = await Promise.all([
      fetch('/api/products/columns').then((r) => r.json()),
      fetch('/api/products').then((r) => r.json()),
    ]);
    return [c, p];
  }

  // Resizing mouse events
  const onMouseDownResize = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    setResizingCol(colKey);
    setStartX(e.clientX);
    setStartWidth(colWidths[colKey] || 160);
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizingCol) return;
      const diff = e.clientX - startX;
      setColWidths((prev) => ({
        ...prev,
        [resizingCol]: Math.max(70, startWidth + diff),
      }));
    };

    const onMouseUp = () => setResizingCol(null);

    if (resizingCol) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [resizingCol, startX, startWidth]);

  // Section detector: finds dynamic Section / Family column
  const sectionFieldKey = useMemo(() => {
    const candidate = columns.find((c) =>
      /family|section|group|type|category/i.test(c.header) || /family|section|group|type|category/i.test(c.key)
    );
    return candidate ? candidate.key : null;
  }, [columns]);

  // Grouping for accordion view
  const groupedData = useMemo(() => {
    const filtered = items.filter((item) => {
      const matchSearch =
        item.sku.toLowerCase().includes(search.toLowerCase()) ||
        Object.values(item.custom_attributes || {}).some((v) =>
          String(v).toLowerCase().includes(search.toLowerCase())
        );
      return matchSearch;
    });

    if (!sectionFieldKey) return { All: filtered };

    const groups: Record<string, InventoryItem[]> = {};
    filtered.forEach((item) => {
      const sec = String(item.custom_attributes?.[sectionFieldKey] || 'Other');
      if (!groups[sec]) groups[sec] = [];
      groups[sec].push(item);
    });
    return groups;
  }, [items, search, sectionFieldKey, columns]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Inventory Explorer</h1>
          <p className="text-xs text-slate-500">Excel grid format: drag headers to resize width, click group arrows to expand rows</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter by SKU, Section, Size..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-slate-300 rounded px-3 py-1.5 text-sm w-72 focus:outline-indigo-500 bg-white"
          />
        </div>
      </div>

      <div className="bg-white border border-slate-300 rounded shadow-sm overflow-x-auto select-none">
        <table className="text-left text-xs border-collapse table-fixed w-full">
          <thead>
            <tr className="bg-slate-100 border-b border-slate-300 text-slate-700 font-semibold">
              <th
                style={{ width: `${colWidths.sku}px` }}
                className="relative border-r border-slate-300 px-3 py-2 text-slate-800"
              >
                SKU / Item Identifier
                <div
                  onMouseDown={(e) => onMouseDownResize('sku', e)}
                  className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-indigo-500"
                />
              </th>
              <th
                style={{ width: `${colWidths.stock}px` }}
                className="relative border-r border-slate-300 px-3 py-2 text-slate-800"
              >
                Stock Qty
                <div
                  onMouseDown={(e) => onMouseDownResize('stock', e)}
                  className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-indigo-500"
                />
              </th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={{ width: `${colWidths[col.key] || 160}px` }}
                  className="relative border-r border-slate-300 px-3 py-2 text-slate-800 truncate"
                >
                  {col.header}
                  <div
                    onMouseDown={(e) => onMouseDownResize(col.key, e)}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-indigo-500"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length + 2} className="p-8 text-center text-slate-400">
                  Loading inventory sheet...
                </td>
              </tr>
            ) : Object.keys(groupedData).length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="p-8 text-center text-slate-400">
                  No records match your filter.
                </td>
              </tr>
            ) : (
              Object.entries(groupedData).map(([sectionName, sectionItems]) => {
                const isExpanded = expandedSections[sectionName] !== false; // Default expanded
                return (
                  <React.Fragment key={sectionName}>
                    {sectionFieldKey && (
                      <tr
                        onClick={() => toggleSection(sectionName)}
                        className="bg-slate-200/70 hover:bg-slate-200 cursor-pointer border-b border-slate-300 font-bold text-slate-800"
                      >
                        <td colSpan={columns.length + 2} className="px-3 py-2 text-xs">
                          <span className="inline-block w-4 text-slate-600 font-mono">
                            {isExpanded ? '▼' : '►'}
                          </span>
                          {sectionName} ({sectionItems.length} items)
                        </td>
                      </tr>
                    )}
                    {isExpanded &&
                      sectionItems.map((item, idx) => (
                        <tr
                          key={item.id || idx}
                          className="hover:bg-indigo-50/40 border-b border-slate-200 divide-x divide-slate-200 font-mono"
                        >
                          <td className="px-3 py-1.5 truncate text-slate-900 font-medium">
                            {item.sku}
                          </td>
                          <td className="px-3 py-1.5 font-bold text-slate-800">
                            {item.current_stock ?? 0}
                          </td>
                          {columns.map((col) => (
                            <td key={col.key} className="px-3 py-1.5 truncate text-slate-600 font-sans">
                              {item.custom_attributes?.[col.key] !== undefined
                                ? String(item.custom_attributes[col.key])
                                : '-'}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
