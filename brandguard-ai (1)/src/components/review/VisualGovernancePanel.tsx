import React, { useState, useEffect } from 'react';
import {
  Image as ImageIcon,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Palette,
  Type as TypeIcon,
  Accessibility,
  Info,
  Save,
} from 'lucide-react';
import { VisualAnalysisResult } from '../../types';
import { api } from '../../services/api';

interface VisualGovernancePanelProps {
  submissionId?: string | null;
  orgName: string;
  canEdit?: boolean;
  initialAnalyses?: VisualAnalysisResult[];
  onAnalysisCompleted?: (analysis: VisualAnalysisResult) => void;
}

export const VisualGovernancePanel: React.FC<VisualGovernancePanelProps> = ({
  submissionId,
  orgName,
  canEdit = true,
  initialAnalyses,
  onAnalysisCompleted,
}) => {
  const [selectedFile, setSelectedFile] = useState<{
    fileName: string;
    mimeType: string;
    base64: string;
    previewUrl: string;
  } | null>(null);
  const [altText, setAltText] = useState('');
  const [foregroundHex, setForegroundHex] = useState('#0F172A');
  const [backgroundHex, setBackgroundHex] = useState('#FFFFFF');
  const [htmlOrCss, setHtmlOrCss] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [analyses, setAnalyses] = useState<VisualAnalysisResult[]>(initialAnalyses || []);
  const [activeAnalysis, setActiveAnalysis] = useState<VisualAnalysisResult | null>(
    initialAnalyses?.[0] || null
  );
  const [editingAltText, setEditingAltText] = useState('');
  const [savingAlt, setSavingAlt] = useState(false);

  useEffect(() => {
    if (initialAnalyses) {
      setAnalyses(initialAnalyses);
      if (initialAnalyses.length > 0) {
        setActiveAnalysis(initialAnalyses[0]);
        setEditingAltText(initialAnalyses[0].alt_text || '');
      }
    }
  }, [initialAnalyses]);

  useEffect(() => {
    if (!initialAnalyses) {
      api
        .getVisualAnalyses(submissionId || undefined)
        .then((res) => {
          setAnalyses(res.analyses);
          if (res.analyses.length > 0) {
            setActiveAnalysis(res.analyses[0]);
            setEditingAltText(res.analyses[0].alt_text || '');
          }
        })
        .catch(() => undefined);
    }
  }, [submissionId, initialAnalyses]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      setSelectedFile({
        fileName: file.name,
        mimeType: file.type,
        base64,
        previewUrl: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleRunVisualAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile && !htmlOrCss.trim() && !(foregroundHex && backgroundHex)) {
      setErrorMsg('Upload a creative image (PNG, JPG, JPEG, WEBP, SVG) or supply CSS/HTML or contrast HEX values.');
      return;
    }

    setIsAnalyzing(true);
    setErrorMsg(null);
    try {
      const res = await api.analyzeVisualAsset({
        fileBase64: selectedFile?.base64,
        fileName: selectedFile?.fileName || 'creative-snippet',
        mimeType: selectedFile?.mimeType,
        altText,
        htmlOrCss: htmlOrCss.trim() || undefined,
        foregroundHex: foregroundHex.trim() || undefined,
        backgroundHex: backgroundHex.trim() || undefined,
        submissionId: submissionId || undefined,
      });
      setActiveAnalysis(res.analysis);
      setEditingAltText(res.analysis.alt_text || '');
      setAnalyses((prev) => [res.analysis, ...prev]);
      showToast(`Visual & accessibility audit completed (${res.analysis.overall_score}%).`);
      onAnalysisCompleted?.(res.analysis);
    } catch (err: any) {
      setErrorMsg(err.message || 'Visual compliance analysis failed.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSaveAltText = async () => {
    if (!activeAnalysis) return;
    setSavingAlt(true);
    setErrorMsg(null);
    try {
      const res = await api.updateVisualAltText(activeAnalysis.id, editingAltText);
      const updated: VisualAnalysisResult = {
        ...activeAnalysis,
        alt_text: res.alt_text,
        findings: res.findings,
        overall_score: res.overall_score,
      };
      setActiveAnalysis(updated);
      setAnalyses((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      showToast('Image alt text updated and accessibility score recalculated.');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update alt text.');
    } finally {
      setSavingAlt(false);
    }
  };

  return (
    <div className="space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900 text-white px-4 py-3 rounded-lg shadow-lg border border-teal-500/40 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-teal-400 shrink-0" />
          <span>{toast}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Visual Submission & Parameters (5 cols) */}
        <form onSubmit={handleRunVisualAnalysis} className="lg:col-span-5 bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-teal-600" />
              <span>Visual Creative & Accessibility Scanner</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Compare creatives against {orgName} approved logos, brand HEX palette, typography, alt text, and WCAG 2.1 AA contrast ratios.
            </p>
          </div>

          <div className="border-2 border-dashed border-slate-300 hover:border-teal-500 rounded-lg p-4 text-center bg-slate-50/70 transition-colors">
            {selectedFile ? (
              <div className="space-y-2">
                <img
                  src={selectedFile.previewUrl}
                  alt={altText || selectedFile.fileName}
                  className="max-h-32 mx-auto rounded border border-slate-200 bg-white p-1 object-contain"
                />
                <div className="text-xs font-semibold text-slate-800">{selectedFile.fileName}</div>
              </div>
            ) : (
              <div className="py-2">
                <Upload className="w-6 h-6 text-slate-400 mx-auto mb-1.5" />
                <div className="text-xs font-semibold text-slate-700">Upload Creative Asset</div>
                <div className="text-[11px] text-slate-400">PNG, JPG, JPEG, WEBP, or SVG (max 10MB)</div>
              </div>
            )}
            <label className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-100 rounded-md text-xs font-medium text-slate-700 cursor-pointer">
              <ImageIcon className="w-3.5 h-3.5" />
              <span>{selectedFile ? 'Replace Image' : 'Select Creative Image'}</span>
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={handleImageSelect}
                disabled={!canEdit}
                className="hidden"
              />
            </label>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Image Alt Text (WCAG Accessibility Check)
            </label>
            <input
              type="text"
              disabled={!canEdit}
              placeholder="e.g., Nova Tech hexagonal emblem on dark slate campaign banner"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">Foreground Text HEX</label>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-6 h-6 rounded border border-slate-300 shrink-0"
                  style={{ backgroundColor: /^#[0-9a-fA-F]{3,6}$/.test(foregroundHex) ? foregroundHex : '#0F172A' }}
                />
                <input
                  type="text"
                  disabled={!canEdit}
                  value={foregroundHex}
                  onChange={(e) => setForegroundHex(e.target.value)}
                  placeholder="#0F172A"
                  className="w-full text-xs font-mono p-1.5 bg-slate-50 border border-slate-200 rounded-md"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">Background HEX</label>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-6 h-6 rounded border border-slate-300 shrink-0"
                  style={{ backgroundColor: /^#[0-9a-fA-F]{3,6}$/.test(backgroundHex) ? backgroundHex : '#FFFFFF' }}
                />
                <input
                  type="text"
                  disabled={!canEdit}
                  value={backgroundHex}
                  onChange={(e) => setBackgroundHex(e.target.value)}
                  placeholder="#FFFFFF"
                  className="w-full text-xs font-mono p-1.5 bg-slate-50 border border-slate-200 rounded-md"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Optional CSS / HTML / SVG Markup (Typography & Styles)
            </label>
            <textarea
              rows={3}
              disabled={!canEdit}
              placeholder=".hero-banner { font-family: 'Plus Jakarta Sans'; color: #0F172A; background-color: #F8FAFC; }"
              value={htmlOrCss}
              onChange={(e) => setHtmlOrCss(e.target.value)}
              className="w-full text-xs font-mono p-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          {errorMsg && (
            <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isAnalyzing || !canEdit}
            className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isAnalyzing ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Running Pixel & WCAG Inspection...</span>
              </>
            ) : (
              <>
                <Eye className="w-4 h-4 text-teal-400" />
                <span>RUN VISUAL & ACCESSIBILITY AUDIT</span>
              </>
            )}
          </button>

          {analyses.length > 1 && (
            <div className="pt-2 border-t border-slate-100">
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Recent Visual Audits</label>
              <select
                value={activeAnalysis?.id || ''}
                onChange={(e) => {
                  const found = analyses.find((a) => a.id === e.target.value);
                  if (found) {
                    setActiveAnalysis(found);
                    setEditingAltText(found.alt_text || '');
                  }
                }}
                className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-md"
              >
                {analyses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.asset_name} ({a.overall_score}%) · {new Date(a.created_at).toLocaleTimeString()}
                  </option>
                ))}
              </select>
            </div>
          )}
        </form>

        {/* Right: Detailed Visual & Accessibility Audit Results (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          {!activeAnalysis ? (
            <div className="bg-white p-10 rounded-xl border border-slate-200 shadow-sm text-center">
              <Palette className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <div className="text-sm font-semibold text-slate-800">No Visual Audit Run Yet</div>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                Upload a creative asset or test colour/typography pairs on the left to verify logo consistency, brand HEX distances, alt text, and WCAG 2.1 contrast ratios.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Score + Side-by-side Logo Comparison */}
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Visual & Accessibility Score
                    </div>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      <span
                        className={`text-3xl font-extrabold font-mono tabular-nums ${
                          activeAnalysis.overall_score >= 80
                            ? 'text-teal-600'
                            : activeAnalysis.overall_score >= 55
                            ? 'text-amber-600'
                            : 'text-rose-600'
                        }`}
                      >
                        {activeAnalysis.overall_score}%
                      </span>
                      <span className="text-xs text-slate-500">
                        {activeAnalysis.asset_name}
                        {activeAnalysis.dimensions
                          ? ` (${activeAnalysis.dimensions.width}×${activeAnalysis.dimensions.height}px)`
                          : ''}
                      </span>
                    </div>
                  </div>
                  {activeAnalysis.logo_similarity_score !== null && (
                    <div className="text-right">
                      <div className="text-[11px] text-slate-500">Logo Perceptual Match</div>
                      <span
                        className={`inline-block mt-1 px-2.5 py-1 rounded text-xs font-mono font-bold ${
                          activeAnalysis.logo_similarity_score >= 70
                            ? 'bg-teal-50 text-teal-700 border border-teal-200'
                            : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}
                      >
                        {activeAnalysis.logo_similarity_score}% Match
                      </span>
                    </div>
                  )}
                </div>

                {(activeAnalysis.image_url || activeAnalysis.matched_logo_path) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                      <div className="text-[10px] font-bold uppercase text-slate-500 mb-2">
                        Approved Reference Logo ({activeAnalysis.matched_logo_name || 'Standard'})
                      </div>
                      {activeAnalysis.matched_logo_path ? (
                        <img
                          src={activeAnalysis.matched_logo_path}
                          alt={activeAnalysis.matched_logo_name || 'Approved Logo'}
                          className="h-24 mx-auto object-contain bg-white rounded p-1.5 border border-slate-200"
                        />
                      ) : (
                        <div className="h-24 flex items-center justify-center text-xs text-slate-400">
                          No reference logo asset
                        </div>
                      )}
                    </div>

                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                      <div className="text-[10px] font-bold uppercase text-slate-500 mb-2">
                        Submitted Creative Preview
                      </div>
                      {activeAnalysis.image_url ? (
                        <img
                          src={activeAnalysis.image_url}
                          alt={activeAnalysis.alt_text || activeAnalysis.asset_name}
                          className="h-24 mx-auto object-contain bg-white rounded p-1.5 border border-slate-200"
                        />
                      ) : (
                        <div className="h-24 flex items-center justify-center text-xs text-slate-400">
                          Markup / Colour-Pair Audit Only
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline Alt-Text Remediation */}
                {activeAnalysis.image_url && (
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                      <span className="flex items-center gap-1.5">
                        <Accessibility className="w-3.5 h-3.5 text-teal-600" />
                        <span>Image Alt Text Editor</span>
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        {editingAltText.trim().length} chars
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        disabled={!canEdit}
                        value={editingAltText}
                        onChange={(e) => setEditingAltText(e.target.value)}
                        placeholder="Add descriptive alt text for screen readers..."
                        className="flex-1 text-xs p-2 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                      />
                      {canEdit && (
                        <button
                          type="button"
                          onClick={handleSaveAltText}
                          disabled={savingAlt}
                          className="px-3 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-md flex items-center gap-1 shrink-0"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{savingAlt ? 'Saving...' : 'Update Alt Text'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Dominant Colors & Palette Distance */}
              {activeAnalysis.extracted_colors.length > 0 && (
                <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Palette className="w-3.5 h-3.5 text-teal-600" />
                    <span>Brand Palette & Colour Distance Analysis</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {activeAnalysis.extracted_colors.map((c, idx) => (
                      <div
                        key={`${c.hex}-${idx}`}
                        className="p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className="w-7 h-7 rounded border border-slate-300 shrink-0"
                            style={{ backgroundColor: c.hex }}
                          />
                          <div>
                            <div className="font-mono font-bold text-slate-900">
                              {c.hex} {c.percentage > 0 ? `(${c.percentage}%)` : ''}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              Nearest approved: <span className="font-mono">{c.nearestApprovedHex}</span> (ΔE {c.deltaE})
                            </div>
                          </div>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                            c.isOnBrand
                              ? 'bg-teal-50 text-teal-700 border border-teal-200'
                              : 'bg-rose-50 text-rose-700 border border-rose-200'
                          }`}
                        >
                          {c.isOnBrand ? 'On-Brand' : 'Deviates'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* WCAG 2.1 Contrast & Typography */}
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                  <Accessibility className="w-3.5 h-3.5 text-teal-600" />
                  <span>WCAG 2.1 Contrast & Typography Checks</span>
                </h4>

                {activeAnalysis.wcag_results.map((w, idx) => (
                  <div
                    key={idx}
                    className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                      w.aaNormalPass ? 'bg-teal-50/40 border-teal-200' : 'bg-rose-50/50 border-rose-200'
                    }`}
                  >
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="font-semibold text-slate-900 flex items-center gap-2">
                        <span
                          className="inline-flex items-center justify-center px-2 py-0.5 rounded font-mono text-[11px] border border-slate-300"
                          style={{ color: w.foregroundHex, backgroundColor: w.backgroundHex }}
                        >
                          Aa {w.foregroundHex}
                        </span>
                        <span>on</span>
                        <span className="font-mono text-[11px]">{w.backgroundHex}</span>
                        <span className="text-slate-500 font-normal">({w.source})</span>
                      </div>
                      <span className="font-mono font-bold text-slate-900">
                        Ratio: {w.contrastRatio}:1 · {w.aaNormalPass ? 'WCAG AA PASS' : 'WCAG AA FAIL'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px]">
                      <span className={w.aaNormalPass ? 'text-teal-700 font-semibold' : 'text-rose-700 font-semibold'}>
                        Normal Text (≥4.5:1): {w.aaNormalPass ? 'Pass' : 'Fail'}
                      </span>
                      <span>·</span>
                      <span className={w.aaLargePass ? 'text-teal-700 font-semibold' : 'text-rose-700 font-semibold'}>
                        Large Text (≥3.0:1): {w.aaLargePass ? 'Pass' : 'Fail'}
                      </span>
                    </div>
                    {w.suggestedForegroundHex && (
                      <div className="text-[11px] text-slate-700 pt-1">
                        <strong>Accessible Fix:</strong> Switch foreground to{' '}
                        <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">
                          {w.suggestedForegroundHex}
                        </code>{' '}
                        for <strong>{w.suggestedContrastRatio}:1</strong> contrast.
                      </div>
                    )}
                  </div>
                ))}

                {activeAnalysis.detected_fonts.length > 0 && (
                  <div className="pt-2 border-t border-slate-100 space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-600 flex items-center gap-1">
                      <TypeIcon className="w-3.5 h-3.5" />
                      <span>Detected Font Declarations</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {activeAnalysis.detected_fonts.map((f, idx) => (
                        <span
                          key={idx}
                          className={`text-xs px-2.5 py-1 rounded border font-mono ${
                            f.approved
                              ? 'bg-teal-50 border-teal-200 text-teal-800'
                              : 'bg-rose-50 border-rose-200 text-rose-800'
                          }`}
                        >
                          {f.family} · {f.approved ? 'Approved' : 'Unapproved'}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {activeAnalysis.limitations.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-600 flex items-start gap-1.5">
                    <Info className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                    <div>
                      <strong>Technical Limitations:</strong> {activeAnalysis.limitations.join(' ')}
                    </div>
                  </div>
                )}
              </div>

              {/* Visual Findings */}
              {activeAnalysis.findings.length > 0 && (
                <div className="space-y-2.5">
                  <div className="text-xs font-bold text-slate-800">
                    Visual & Accessibility Findings ({activeAnalysis.findings.length})
                  </div>
                  {activeAnalysis.findings.map((f) => (
                    <div key={f.id} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-900">
                          [{f.category}] {f.title}
                        </span>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                            f.severity === 'High'
                              ? 'bg-rose-50 text-rose-800 border border-rose-200'
                              : 'bg-amber-50 text-amber-800 border border-amber-200'
                          }`}
                        >
                          {f.severity}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">{f.explanation}</p>
                      <div className="p-2 rounded bg-teal-50/60 border border-teal-200 text-xs text-teal-950">
                        <strong>Recommended Fix:</strong> {f.suggested_fix}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400">Evidence: {f.evidence}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
