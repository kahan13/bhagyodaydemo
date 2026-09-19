'use client';

import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';

interface ColumnDef {
  key: string;
  header: string;
}

export default function ProductMasterPage() {
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [sheetSheets, setSheetSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [headerLabels, setHeaderLabels] = useState<Record<string, string>>({});
  const [selectedColumns, setSelectedColumns] = useState<Record<string, boolean>>({});
  const [skuField, setSkuField] = useState<string>('');
  const [stockField, setStockField] = useState<string>('');
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<any | null>(null);

  const fetchConfigAndData = async () => {
    const colRes = await fetch('/api/products/columns');
    const colData = await colRes.json();
    if (colData.columns && colData.columns.length > 0) {
      setColumns(colData.columns);
    }

    const prodRes = await fetch('/api/products');
    const prodData = await prodRes.json();
    if (prodData.products) {
      setProducts(prodData.products);
    }
  };

  useEffect(() => {
    fetchConfigAndData();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      setWorkbook(wb);
      setSheetSheets(wb.SheetNames);
      const firstSheet = wb.SheetNames[0];
      setSelectedSheet(firstSheet);
      readSheetHeaders(wb, firstSheet);
      setIsUploadModalOpen(true);
    };
    reader.readAsBinaryString(file);
  };

  const readSheetHeaders = (wb: XLSX.WorkBook, sheetName: string) => {
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<Record<string, any>>(ws);
    if (data.length > 0) {
      const headers = Object.keys(data[0]);
      setRawHeaders(headers);
      const labels: Record<string, string> = {};
      const active: Record<string, boolean> = {};
      headers.forEach((h) => {
        labels[h] = h;
        active[h] = true;
      });
      setHeaderLabels(labels);
      setSelectedColumns(active);
      const likelySku = headers.find((h) => /sku|code|id/i.test(h)) || headers[0];
      const likelyStock = headers.find((h) => /opening_stock|stock|qty|quantity/i.test(h)) || '';
      setSkuField(likelySku);
      setStockField(likelyStock);
    }
  };

  const handleSheetChange = (sheetName: string) => {
    setSelectedSheet(sheetName);
    if (workbook) {
      readSheetHeaders(workbook, sheetName);
    }
  };

  const handleSaveDynamicSheet = async () => {
    if (!workbook || !selectedSheet) return;
    const ws = workbook.Sheets[selectedSheet];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws);

    const chosenColumns: ColumnDef[] = rawHeaders
      .filter((h) => selectedColumns[h])
      .map((h) => ({
        key: h,
        header: headerLabels[h] || h,
      }));

    await fetch('/api/products/columns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns: chosenColumns }),
    });

    const payload = rows.map((row) => {
      const sku = String(row[skuField] || `SKU-${Date.now()}-${Math.random().toString(36).substring(7)}`);
      const stock = stockField && row[stockField] !== undefined ? Number(row[stockField]) || 0 : 0;
      const custom_attributes: Record<string, any> = {};
      chosenColumns.forEach((col) => {
        custom_attributes[col.key] = row[col.key] ?? '';
      });

      return {
        sku,
        current_stock: stock,
        custom_attributes,
      };
    });

    await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setIsUploadModalOpen(false);
    fetchConfigAndData();
  };

  const handleSaveProduct = async () => {
    if (!editingProduct) return;
    const body = {
      sku: editingProduct.sku,
      current_stock: Number(editingProduct.current_stock) || 0,
      custom_attributes: editingProduct.custom_attributes || {},
    };

    if (editingProduct.id) {
      await fetch('/api/products', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingProduct.id, ...body }),
      });
    } else {
      await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    setEditingProduct(null);
    fetchConfigAndData();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this product?')) return;
    await fetch(`/api/products?id=${id}`, { method: 'DELETE' });
    fetchConfigAndData();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Product Master</h1>
          <p className="text-sm text-slate-500">Headers and columns adapt dynamically to your uploaded sheet</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="cursor-pointer bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-md text-sm font-medium shadow-sm transition">
            Upload Excel Sheet
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileChange} />
          </label>
          <button
            onClick={() => setEditingProduct({ sku: '', current_stock: 0, custom_attributes: {} })}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-sm font-medium shadow-sm transition"
          >
            + Add Product
          </button>
        </div>
      </div>

      {isUploadModalOpen && (
        <div className="p-5 bg-white border border-indigo-200 rounded-lg shadow space-y-4">
          <div className="flex justify-between items-center border-b pb-3">
            <h2 className="text-lg font-semibold text-slate-800">Map & Rename File Headers</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase text-slate-500">Sheet:</span>
              <select
                value={selectedSheet}
                onChange={(e) => handleSheetChange(e.target.value)}
                className="border rounded px-2 py-1 text-sm bg-slate-50"
              >
                {sheetSheets.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pb-2 border-b">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Unique Identifier / SKU Column</label>
              <select
                value={skuField}
                onChange={(e) => setSkuField(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                {rawHeaders.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Stock / Quantity Column</label>
              <select
                value={stockField}
                onChange={(e) => setStockField(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                <option value="">-- None / Default 0 --</option>
                {rawHeaders.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-600">App display headers (edit header text as desired):</p>
            <div className="max-h-60 overflow-y-auto space-y-2 border p-3 rounded bg-slate-50">
              {rawHeaders.map((header) => (
                <div key={header} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={!!selectedColumns[header]}
                    onChange={(e) => setSelectedColumns({ ...selectedColumns, [header]: e.target.checked })}
                    className="rounded text-indigo-600"
                  />
                  <span className="text-xs font-mono w-48 truncate text-slate-700">{header}</span>
                  <span className="text-xs text-slate-400">→</span>
                  <input
                    type="text"
                    value={headerLabels[header] || ''}
                    onChange={(e) => setHeaderLabels({ ...headerLabels, [header]: e.target.value })}
                    placeholder="App display header"
                    className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm bg-white"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setIsUploadModalOpen(false)} className="px-4 py-1.5 text-sm border rounded">Cancel</button>
            <button onClick={handleSaveDynamicSheet} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded font-medium">
              Save Dynamic Headers & Import
            </button>
          </div>
        </div>
      )}

      {editingProduct && (
        <div className="p-4 bg-white border border-slate-300 rounded-lg shadow-sm space-y-4">
          <h2 className="text-md font-semibold">{editingProduct.id ? 'Edit Product' : 'Add New Product'}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-600">SKU</label>
              <input
                type="text"
                className="w-full border p-2 rounded text-sm mt-1"
                value={editingProduct.sku || ''}
                onChange={(e) => setEditingProduct({ ...editingProduct, sku: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600">Stock</label>
              <input
                type="number"
                className="w-full border p-2 rounded text-sm mt-1"
                value={editingProduct.current_stock || 0}
                onChange={(e) => setEditingProduct({ ...editingProduct, current_stock: e.target.value })}
              />
            </div>
            {columns.map((col) => (
              <div key={col.key}>
                <label className="text-xs font-semibold text-slate-600">{col.header}</label>
                <input
                  type="text"
                  className="w-full border p-2 rounded text-sm mt-1"
                  value={editingProduct.custom_attributes?.[col.key] || ''}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      custom_attributes: {
                        ...(editingProduct.custom_attributes || {}),
                        [col.key]: e.target.value,
                      },
                    })
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditingProduct(null)} className="px-3 py-1.5 text-sm border rounded">Cancel</button>
            <button onClick={handleSaveProduct} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded font-medium">Save</button>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto shadow-sm">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-slate-100 border-b text-slate-700 text-xs uppercase font-semibold">
            <tr>
              <th className="p-3">SKU</th>
              <th className="p-3">Current Stock</th>
              {columns.map((col) => (
                <th key={col.key} className="p-3 border-l border-slate-200">{col.header}</th>
              ))}
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {products.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="p-3 font-mono text-xs font-medium text-slate-900">{p.sku}</td>
                <td className="p-3 font-semibold text-slate-800">{p.current_stock ?? 0}</td>
                {columns.map((col) => (
                  <td key={col.key} className="p-3 text-slate-600 border-l border-slate-100">
                    {p.custom_attributes?.[col.key] !== undefined ? String(p.custom_attributes[col.key]) : '-'}
                  </td>
                ))}
                <td className="p-3 text-right space-x-2">
                  <button onClick={() => setEditingProduct(p)} className="text-indigo-600 hover:underline">Edit</button>
                  <button onClick={() => handleDelete(p.id)} className="text-rose-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3} className="p-8 text-center text-slate-400">
                  No products imported yet. Click "Upload Excel Sheet" above to map custom headers and populate the catalog.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
