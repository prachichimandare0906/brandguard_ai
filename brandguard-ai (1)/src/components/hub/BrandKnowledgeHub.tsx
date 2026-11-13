import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
  Upload,
  FileText,
  Search,
  Edit3,
  Lock,
  Image as ImageIcon,
  Database,
  Sparkles,
  Palette,
  Type,
  AlertTriangle,
} from 'lucide-react';
import {
  Guideline,
  ApprovedFact,
  TerminologyItem,
  BrandAsset,
  GuidelineCategory,
  SeverityLevel,
  UserRole,
  RagDocument,
  RetrievedEvidenceItem,
  RetrievalSummary,
  OrgBrandSettings,
} from '../../types';
import { api } from '../../services/api';

interface HubProps {
  guidelines: Guideline[];
  facts: ApprovedFact[];
  terminology: TerminologyItem[];
  assets: BrandAsset[];
  orgName: string;
  userRole: UserRole;
  onRefresh: () => void;
}

type HubSection = 'guidelines' | 'facts' | 'terminology' | 'assets' | 'upload_doc';

export const BrandKnowledgeHub: React.FC<HubProps> = ({
  guidelines,
  facts,
  terminology,
  assets,
  orgName,
  userRole,
  onRefresh,
}) => {
  const isAdmin = userRole === 'admin';
  const canManagePolicies = userRole === 'admin' || userRole === 'brand_manager';

  const [activeSection, setActiveSection] = useState<HubSection>('guidelines');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'guideline' | 'fact' | 'term' | 'asset' | 'rag_doc';
    id: string;
    label: string;
  } | null>(null);

  // Guideline Add / Edit State
  const [isAddingGuideline, setIsAddingGuideline] = useState(false);
  const [editingGuidelineId, setEditingGuidelineId] = useState<string | null>(null);
  const [guidelineForm, setGuidelineForm] = useState<{
    title: string;
    category: GuidelineCategory;
    description: string;
    severity: SeverityLevel;
    source_document: string;
    prohibited_phrase: string;
    preferred_replacement: string;
  }>({
    title: '',
    category: 'Tone',
    description: '',
    severity: 'Medium',
    source_document: 'Policy_Addendum_2026.pdf',
    prohibited_phrase: '',
    preferred_replacement: '',
  });

  const [isAddingFact, setIsAddingFact] = useState(false);
  const [newFact, setNewFact] = useState({ fact: '', source: '' });

  const [isAddingTerm, setIsAddingTerm] = useState(false);
  const [newTerm, setNewTerm] = useState({ prohibited_term: '', preferred_term: '', explanation: '' });

  const [isAddingAsset, setIsAddingAsset] = useState(false);
  const [newAsset, setNewAsset] = useState({
    asset_name: '',
    asset_type: 'Logo',
    file_path: '',
    guidelines: '',
    fileBase64: '',
    fileName: '',
    mimeType: '',
  });

  // Org Brand Palette & Fonts Settings (Admin-editable, read by Visual Engine)
  const [brandSettings, setBrandSettings] = useState<OrgBrandSettings>({
    primaryColors: ['#0F172A', '#0D9488', '#F8FAFC'],
    approvedFonts: ['Plus Jakarta Sans', 'JetBrains Mono'],
  });
  const [isEditingBrandSettings, setIsEditingBrandSettings] = useState(false);
  const [colorsInput, setColorsInput] = useState('');
  const [fontsInput, setFontsInput] = useState('');
  const [isSavingBrandSettings, setIsSavingBrandSettings] = useState(false);

  // RAG Policy Documents & Evidence Search State
  const [ragDocuments, setRagDocuments] = useState<RagDocument[]>([]);
  const [loadingRagDocs, setLoadingRagDocs] = useState(false);
  const [isIndexingDoc, setIsIndexingDoc] = useState(false);
  const [ragSearchQuery, setRagSearchQuery] = useState('');
  const [isSearchingRag, setIsSearchingRag] = useState(false);
  const [ragSearchResult, setRagSearchResult] = useState<
    (RetrievalSummary & { items: RetrievedEvidenceItem[] }) | null
  >(null);

  // Document Upload & Raw Preview State (Round 2 preserved)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [extractedDocText, setExtractedDocText] = useState<string>('');
  const [docParseWarnings, setDocParseWarnings] = useState<string[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const loadHubExtras = useCallback(async () => {
    setLoadingRagDocs(true);
    try {
      const [docsRes, settingsRes] = await Promise.all([
        api.getRagDocuments(),
        api.getOrgBrandSettings(),
      ]);
      setRagDocuments(docsRes.documents || []);
      setBrandSettings(settingsRes);
      setColorsInput((settingsRes.primaryColors || []).join(', '));
      setFontsInput((settingsRes.approvedFonts || []).join(', '));
    } catch {
      // Errors surfaced when performing interactive actions
    } finally {
      setLoadingRagDocs(false);
    }
  }, []);

  useEffect(() => {
    loadHubExtras();
  }, [orgName, loadHubExtras]);

  // Filters
  const filteredGuidelines = guidelines.filter((g) => {
    const matchesSearch =
      g.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (g.prohibited_phrase && g.prohibited_phrase.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCat = selectedCategory === 'All' || g.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  const filteredFacts = facts.filter(
    (f) =>
      f.fact.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.source.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredTerms = terminology.filter(
    (t) =>
      t.prohibited_term.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.preferred_term.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.explanation.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Handlers
  const openCreateGuideline = () => {
    setEditingGuidelineId(null);
    setGuidelineForm({
      title: '',
      category: 'Tone',
      description: '',
      severity: 'Medium',
      source_document: 'Policy_Addendum_2026.pdf',
      prohibited_phrase: '',
      preferred_replacement: '',
    });
    setIsAddingGuideline(true);
  };

  const openEditGuideline = (rule: Guideline) => {
    setEditingGuidelineId(rule.id);
    setGuidelineForm({
      title: rule.title,
      category: rule.category,
      description: rule.description,
      severity: rule.severity,
      source_document: rule.source_document || 'Corporate Standard',
      prohibited_phrase: rule.prohibited_phrase || '',
      preferred_replacement: rule.preferred_replacement || '',
    });
    setIsAddingGuideline(true);
  };

  const handleSaveGuideline = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    if (!guidelineForm.title || !guidelineForm.description) return;
    try {
      if (editingGuidelineId) {
        await api.updateGuideline(editingGuidelineId, guidelineForm);
        showToast('Brand guideline updated.');
      } else {
        await api.createGuideline(guidelineForm);
        showToast('Brand guideline created.');
      }
      setIsAddingGuideline(false);
      setEditingGuidelineId(null);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to save guideline.');
    }
  };

  const handleCreateFact = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    if (!newFact.fact || !newFact.source) return;
    try {
      await api.createFact(newFact);
      setIsAddingFact(false);
      setNewFact({ fact: '', source: '' });
      showToast('Approved corporate fact added.');
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to add approved fact.');
    }
  };

  const handleCreateTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    if (!newTerm.prohibited_term || !newTerm.preferred_term) return;
    try {
      await api.createTerminology(newTerm);
      setIsAddingTerm(false);
      setNewTerm({ prohibited_term: '', preferred_term: '', explanation: '' });
      showToast('Terminology rule saved.');
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to add terminology rule.');
    }
  };

  const handleAssetImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      setNewAsset((prev) => ({
        ...prev,
        fileBase64: base64,
        fileName: file.name,
        mimeType: file.type,
      }));
    };
    reader.readAsDataURL(file);
  };

  const handleCreateAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    if (!newAsset.asset_name || !newAsset.asset_type) return;
    try {
      await api.createAsset({
        asset_name: newAsset.asset_name,
        asset_type: newAsset.asset_type,
        file_path: newAsset.file_path,
        guidelines: newAsset.guidelines,
        fileBase64: newAsset.fileBase64 || undefined,
        fileName: newAsset.fileName || undefined,
        mimeType: newAsset.mimeType || undefined,
      });
      setIsAddingAsset(false);
      setNewAsset({
        asset_name: '',
        asset_type: 'Logo',
        file_path: '',
        guidelines: '',
        fileBase64: '',
        fileName: '',
        mimeType: '',
      });
      showToast('Approved brand asset saved.');
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to save brand asset.');
    }
  };

  const handleSaveBrandSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setIsSavingBrandSettings(true);
    try {
      const primaryColors = colorsInput
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const approvedFonts = fontsInput
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);

      const saved = await api.updateOrgBrandSettings({ primaryColors, approvedFonts });
      setBrandSettings(saved);
      setColorsInput(saved.primaryColors.join(', '));
      setFontsInput(saved.approvedFonts.join(', '));
      setIsEditingBrandSettings(false);
      showToast('Organisation brand palette & approved fonts updated.');
    } catch (err: any) {
      setActionError(err.message || 'Failed to update organisation brand settings.');
    } finally {
      setIsSavingBrandSettings(false);
    }
  };

  const executeConfirmedDelete = async () => {
    if (!confirmDelete) return;
    setActionError(null);
    try {
      if (confirmDelete.type === 'guideline') await api.deleteGuideline(confirmDelete.id);
      if (confirmDelete.type === 'fact') await api.deleteFact(confirmDelete.id);
      if (confirmDelete.type === 'term') await api.deleteTerminology(confirmDelete.id);
      if (confirmDelete.type === 'asset') await api.deleteAsset(confirmDelete.id);
      if (confirmDelete.type === 'rag_doc') {
        await api.deleteRagDocument(confirmDelete.id);
        await loadHubExtras();
      }
      showToast(`Deleted "${confirmDelete.label}".`);
      setConfirmDelete(null);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Delete failed.');
      setConfirmDelete(null);
    }
  };

  const readFileBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.split(',')[1] || '');
      };
      reader.onerror = () => reject(new Error('Failed reading file from disk.'));
      reader.readAsDataURL(file);
    });

  const handleRagIngestUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploadedFile(file);
    setExtractError(null);
    setDocParseWarnings([]);
    setIsIndexingDoc(true);
    try {
      const base64 = await readFileBase64(file);
      const { document } = await api.ingestRagDocument(base64, file.name, file.type);
      if (document.extracted_text_preview) {
        setExtractedDocText(document.extracted_text_preview);
      }
      if (document.warnings && document.warnings.length > 0) {
        setDocParseWarnings(document.warnings);
      }
      await loadHubExtras();
      showToast(
        `Indexed "${document.filename}" (${document.chunk_count} chunks across ${document.page_count} page${
          document.page_count === 1 ? '' : 's'
        }).`
      );
    } catch (err: any) {
      setExtractError(err.message || 'Failed to ingest and index policy document.');
    } finally {
      setIsIndexingDoc(false);
    }
  };

  const handleInspectRawTextOnly = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploadedFile(file);
    setIsExtracting(true);
    setExtractError(null);
    setDocParseWarnings([]);

    try {
      const base64 = await readFileBase64(file);
      const result = await api.parseDocument(base64, file.name, file.type);
      setExtractedDocText(result.text);
      if (result.warnings && result.warnings.length > 0) {
        setDocParseWarnings(result.warnings);
      }
    } catch (err: any) {
      setExtractError(err.message || 'Error extracting document text.');
    } finally {
      setIsExtracting(false);
    }
  };

  const handleTestRagSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ragSearchQuery.trim()) return;
    setIsSearchingRag(true);
    setExtractError(null);
    try {
      const res = await api.searchRagEvidence(ragSearchQuery.trim(), 6);
      setRagSearchResult(res);
    } catch (err: any) {
      setExtractError(err.message || 'Evidence search failed.');
    } finally {
      setIsSearchingRag(false);
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

      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-sm w-full p-5 space-y-4">
            <h3 className="text-sm font-bold text-slate-900">Confirm Deletion</h3>
            <p className="text-xs text-slate-600">
              Remove <strong>{confirmDelete.label}</strong> from {orgName}?{' '}
              {confirmDelete.type === 'rag_doc'
                ? 'All indexed vector chunks for this document will also be removed.'
                : 'This action is recorded in the audit log.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={executeConfirmedDelete}
                className="px-3.5 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded-md"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header and section switcher */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-teal-600" />
            <span>Brand Knowledge Hub</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Single source of truth for {orgName} guidelines, verified facts, RAG policy index, and visual assets
          </p>
        </div>

        {/* Navigation Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 rounded-lg text-xs font-medium">
          <button
            onClick={() => setActiveSection('guidelines')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              activeSection === 'guidelines'
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Guidelines ({guidelines.length})
          </button>
          <button
            onClick={() => setActiveSection('facts')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              activeSection === 'facts'
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Approved Facts ({facts.length})
          </button>
          <button
            onClick={() => setActiveSection('terminology')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              activeSection === 'terminology'
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Terminology ({terminology.length})
          </button>
          <button
            onClick={() => setActiveSection('assets')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              activeSection === 'assets'
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Brand Assets ({assets.length})
          </button>
          <button
            onClick={() => setActiveSection('upload_doc')}
            className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-1 ${
              activeSection === 'upload_doc'
                ? 'bg-teal-600 text-white shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            <span>Policy Docs & RAG ({ragDocuments.length})</span>
          </button>
        </div>
      </div>

      {!canManagePolicies ? (
        <div className="p-3 rounded-lg bg-slate-100 border border-slate-200 text-xs text-slate-700 flex items-center gap-2">
          <Lock className="w-4 h-4 text-slate-500 shrink-0" />
          <span>
            You are signed in as <strong>{userRole.replace('_', ' ')}</strong>. You have read-only access to the Brand
            Knowledge Hub; Brand Managers and Administrators maintain official policies, facts, and RAG documents.
          </span>
        </div>
      ) : (
        userRole === 'brand_manager' && (
          <div className="p-3 rounded-lg bg-teal-50/70 border border-teal-200 text-xs text-teal-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
            <span>
              <strong>Brand Manager Governance Access:</strong> You can manage guidelines, approved facts, terminology,
              brand assets, and RAG policy documents for {orgName}. Organisation-wide palette/fonts and member roles remain
              Administrator-only.
            </span>
          </div>
        )
      )}

      {actionError && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* SECTION 1: GUIDELINES */}
      {activeSection === 'guidelines' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 flex-1 max-w-lg">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search guidelines, prohibited words..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full text-xs pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                aria-label="Filter guideline categories"
                className="text-xs bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500"
              >
                <option value="All">All Categories</option>
                <option value="Tone">Tone</option>
                <option value="Terminology">Terminology</option>
                <option value="Messaging">Messaging</option>
                <option value="Facts">Facts</option>
                <option value="Claims">Claims</option>
                <option value="Visual identity">Visual identity</option>
                <option value="Accessibility">Accessibility</option>
              </select>
            </div>

            {canManagePolicies && (
              <button
                onClick={openCreateGuideline}
                className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Add Brand Rule</span>
              </button>
            )}
          </div>

          {isAddingGuideline && canManagePolicies && (
            <div className="bg-white p-5 rounded-xl border border-teal-200 shadow-md">
              <h3 className="text-sm font-bold text-slate-900 mb-3">
                {editingGuidelineId ? `Edit Brand Guideline (${editingGuidelineId})` : 'Create New Brand Guideline Rule'}
              </h3>
              <form onSubmit={handleSaveGuideline} className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Rule Title</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Friendly & Informative Tone"
                      value={guidelineForm.title}
                      onChange={(e) => setGuidelineForm({ ...guidelineForm, title: e.target.value })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md focus:ring-2 focus:ring-teal-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Category</label>
                    <select
                      value={guidelineForm.category}
                      onChange={(e) => setGuidelineForm({ ...guidelineForm, category: e.target.value as any })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md"
                    >
                      <option value="Tone">Tone</option>
                      <option value="Terminology">Terminology</option>
                      <option value="Messaging">Messaging</option>
                      <option value="Facts">Facts</option>
                      <option value="Claims">Claims</option>
                      <option value="Visual identity">Visual identity</option>
                      <option value="Accessibility">Accessibility</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Severity</label>
                    <select
                      value={guidelineForm.severity}
                      onChange={(e) => setGuidelineForm({ ...guidelineForm, severity: e.target.value as any })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md"
                    >
                      <option value="High">High (Blocking Violation)</option>
                      <option value="Medium">Medium (Correction Required)</option>
                      <option value="Low">Low (Stylistic Advisory)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Rule Description & Rationale</label>
                  <textarea
                    rows={2}
                    required
                    placeholder="Provide full description of why this rule exists and how creators should adhere..."
                    value={guidelineForm.description}
                    onChange={(e) => setGuidelineForm({ ...guidelineForm, description: e.target.value })}
                    className="w-full text-xs p-2 border border-slate-200 rounded-md focus:ring-2 focus:ring-teal-500"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Prohibited Phrase (Optional)</label>
                    <input
                      type="text"
                      placeholder="e.g. guarantees results"
                      value={guidelineForm.prohibited_phrase}
                      onChange={(e) => setGuidelineForm({ ...guidelineForm, prohibited_phrase: e.target.value })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Preferred Replacement</label>
                    <input
                      type="text"
                      placeholder="e.g. designed to deliver measurable results"
                      value={guidelineForm.preferred_replacement}
                      onChange={(e) => setGuidelineForm({ ...guidelineForm, preferred_replacement: e.target.value })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Source Document Reference</label>
                    <input
                      type="text"
                      placeholder="e.g. Brand_Guide_2026.pdf"
                      value={guidelineForm.source_document}
                      onChange={(e) => setGuidelineForm({ ...guidelineForm, source_document: e.target.value })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingGuideline(false);
                      setEditingGuidelineId(null);
                    }}
                    className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 rounded-md"
                  >
                    {editingGuidelineId ? 'Update Guideline' : 'Save Guideline'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredGuidelines.map((rule) => {
              let sevColor = 'text-amber-700 bg-amber-50 border-amber-200';
              if (rule.severity === 'High') sevColor = 'text-rose-700 bg-rose-50 border-rose-200';
              else if (rule.severity === 'Low') sevColor = 'text-blue-700 bg-blue-50 border-blue-200';

              return (
                <div
                  key={rule.id}
                  className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                          <span className="font-mono text-slate-600">{rule.id}</span>
                          <span>·</span>
                          <span className="font-medium text-slate-700">{rule.category}</span>
                          <span>·</span>
                          <span>{rule.source_document || 'Corporate Standard'}</span>
                        </div>
                        <h4 className="text-sm font-bold text-slate-900 mt-1">{rule.title}</h4>
                      </div>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${sevColor}`}>
                        {rule.severity}
                      </span>
                    </div>

                    <p className="text-xs text-slate-600 leading-relaxed mb-3">{rule.description}</p>

                    {(rule.prohibited_phrase || rule.preferred_replacement) && (
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                        {rule.prohibited_phrase && (
                          <div className="flex items-center gap-1.5 text-rose-700">
                            <span className="font-semibold text-[11px] uppercase tracking-wider text-rose-800">
                              Prohibited:
                            </span>
                            <code className="bg-rose-100/60 px-1 rounded font-mono text-[11px]">
                              "{rule.prohibited_phrase}"
                            </code>
                          </div>
                        )}
                        {rule.preferred_replacement && (
                          <div className="flex items-center gap-1.5 text-teal-800">
                            <span className="font-semibold text-[11px] uppercase tracking-wider text-teal-900">
                              Preferred:
                            </span>
                            <span className="font-medium">"{rule.preferred_replacement}"</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-3 mt-3 border-t border-slate-100 text-[11px] text-slate-500">
                    <span>Added {new Date(rule.created_at).toLocaleDateString()}</span>
                    {canManagePolicies && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEditGuideline(rule)}
                          className="text-slate-400 hover:text-teal-700 transition-colors p-1"
                          title="Edit Rule"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setConfirmDelete({ type: 'guideline', id: rule.id, label: rule.title })}
                          className="text-slate-400 hover:text-rose-600 transition-colors p-1"
                          title="Delete Rule"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SECTION 2: APPROVED FACTS */}
      {activeSection === 'facts' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search verified corporate facts..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full text-xs pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
            {canManagePolicies && (
              <button
                onClick={() => setIsAddingFact(true)}
                className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add Verified Fact</span>
              </button>
            )}
          </div>

          {isAddingFact && canManagePolicies && (
            <div className="bg-white p-5 rounded-xl border border-teal-200 shadow-md">
              <h3 className="text-sm font-bold text-slate-900 mb-2">Register Approved Corporate Fact</h3>
              <form onSubmit={handleCreateFact} className="space-y-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Fact Statement</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Company achieved 99.99% uptime SLA across 2025."
                    value={newFact.fact}
                    onChange={(e) => setNewFact({ ...newFact, fact: e.target.value })}
                    className="w-full text-xs p-2 border border-slate-200 rounded-md focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Verifiable Source / Audit Document
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. SOC 2 Type II Compliance Report 2025"
                    value={newFact.source}
                    onChange={(e) => setNewFact({ ...newFact, source: e.target.value })}
                    className="w-full text-xs p-2 border border-slate-200 rounded-md focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsAddingFact(false)}
                    className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 rounded-md"
                  >
                    Save Approved Fact
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-5">ID</th>
                  <th className="py-3 px-5">Approved Fact Statement</th>
                  <th className="py-3 px-5">Verification Source</th>
                  <th className="py-3 px-5">Verified Date</th>
                  {canManagePolicies && <th className="py-3 px-5 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredFacts.map((fact) => (
                  <tr key={fact.id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-3.5 px-5 font-mono text-[11px] text-slate-500">{fact.id}</td>
                    <td className="py-3.5 px-5 font-medium text-slate-900 max-w-md">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0 mt-0.5" />
                        <span>{fact.fact}</span>
                      </div>
                    </td>
                    <td className="py-3.5 px-5 text-slate-600">{fact.source}</td>
                    <td className="py-3.5 px-5 text-slate-500 font-mono text-[11px]">
                      {new Date(fact.verified_at).toLocaleDateString()}
                    </td>
                    {canManagePolicies && (
                      <td className="py-3.5 px-5 text-right">
                        <button
                          onClick={() => setConfirmDelete({ type: 'fact', id: fact.id, label: fact.id })}
                          className="text-slate-400 hover:text-rose-600 transition-colors p-1"
                          title="Delete Fact"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION 3: TERMINOLOGY */}
      {activeSection === 'terminology' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search prohibited or preferred terms..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full text-xs pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
            {canManagePolicies && (
              <button
                onClick={() => setIsAddingTerm(true)}
                className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add Terminology Rule</span>
              </button>
            )}
          </div>

          {isAddingTerm && canManagePolicies && (
            <div className="bg-white p-5 rounded-xl border border-teal-200 shadow-md">
              <h3 className="text-sm font-bold text-slate-900 mb-2">Define Corporate Terminology</h3>
              <form onSubmit={handleCreateTerm} className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Prohibited Term</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. users"
                      value={newTerm.prohibited_term}
                      onChange={(e) => setNewTerm({ ...newTerm, prohibited_term: e.target.value })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md focus:ring-2 focus:ring-teal-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Preferred Replacement Term
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. customers"
                      value={newTerm.preferred_term}
                      onChange={(e) => setNewTerm({ ...newTerm, preferred_term: e.target.value })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-md focus:ring-2 focus:ring-teal-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Reason & Context</label>
                  <input
                    type="text"
                    placeholder="e.g. In marketing copy, use customers to reinforce professional relationship."
                    value={newTerm.explanation}
                    onChange={(e) => setNewTerm({ ...newTerm, explanation: e.target.value })}
                    className="w-full text-xs p-2 border border-slate-200 rounded-md"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsAddingTerm(false)}
                    className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 rounded-md"
                  >
                    Save Term Rule
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTerms.map((t) => (
              <div
                key={t.id}
                className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono mb-2">
                    <span>{t.id}</span>
                    {canManagePolicies && (
                      <button
                        onClick={() => setConfirmDelete({ type: 'term', id: t.id, label: t.prohibited_term })}
                        className="text-slate-400 hover:text-rose-600 transition-colors p-1"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="space-y-2 mb-3">
                    <div className="flex items-center justify-between p-2 rounded-md bg-rose-50 border border-rose-100 text-xs">
                      <span className="font-semibold text-rose-800">Prohibited:</span>
                      <code className="font-mono text-rose-900 font-bold text-xs">{t.prohibited_term}</code>
                    </div>

                    <div className="flex items-center justify-between p-2 rounded-md bg-teal-50 border border-teal-100 text-xs">
                      <span className="font-semibold text-teal-800">Preferred:</span>
                      <span className="font-bold text-teal-950 text-xs">{t.preferred_term}</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 italic">
                    {t.explanation || 'Approved brand terminology standard.'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SECTION 4: ASSETS & ORG BRAND PALETTE/FONTS */}
      {activeSection === 'assets' && (
        <div className="space-y-5">
          {/* Organisation Visual Standards (Palette & Fonts for Visual & WCAG Governance) */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Palette className="w-4 h-4 text-teal-600" />
                  <span>Organisation Approved Palette & Typography Tokens</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Enforced by the Visual Brand Governance & WCAG Accessibility engine across {orgName}.
                </p>
              </div>
              {isAdmin ? (
                <button
                  onClick={() => setIsEditingBrandSettings(!isEditingBrandSettings)}
                  className="px-3 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg border border-slate-200 flex items-center gap-1.5 shrink-0"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>{isEditingBrandSettings ? 'Close Editor' : 'Edit Palette & Fonts'}</span>
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200">
                  <Lock className="w-3 h-3" />
                  <span>Admin-managed settings</span>
                </span>
              )}
            </div>

            {isEditingBrandSettings && isAdmin ? (
              <form
                onSubmit={handleSaveBrandSettings}
                className="p-4 rounded-xl bg-slate-50 border border-teal-200 space-y-3"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Approved HEX Brand Colours (comma separated)
                    </label>
                    <input
                      type="text"
                      required
                      value={colorsInput}
                      onChange={(e) => setColorsInput(e.target.value)}
                      placeholder="#0F172A, #0D9488, #F8FAFC"
                      className="w-full text-xs font-mono p-2 bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Approved Typography Families (comma separated)
                    </label>
                    <input
                      type="text"
                      required
                      value={fontsInput}
                      onChange={(e) => setFontsInput(e.target.value)}
                      placeholder="Plus Jakarta Sans, JetBrains Mono"
                      className="w-full text-xs p-2 bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsEditingBrandSettings(false)}
                    className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded-md"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingBrandSettings}
                    className="px-4 py-1.5 text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 rounded-md disabled:opacity-50"
                  >
                    {isSavingBrandSettings ? 'Saving...' : 'Save Visual Standards'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                    Approved Brand HEX Palette
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {brandSettings.primaryColors.map((hex) => (
                      <div key={hex} className="flex items-center gap-2 bg-white px-2.5 py-1.5 rounded border border-slate-200">
                        <span
                          className="w-5 h-5 rounded border border-slate-300 shrink-0"
                          style={{ backgroundColor: hex }}
                        />
                        <span className="text-xs font-mono font-semibold text-slate-800">{hex}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                    <Type className="w-3.5 h-3.5" />
                    <span>Approved Typography Families</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {brandSettings.approvedFonts.map((font) => (
                      <span
                        key={font}
                        className="px-2.5 py-1 rounded bg-white border border-slate-200 text-xs font-semibold text-slate-800"
                      >
                        {font}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Registered Brand Visual Assets */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Approved Brand Visual Assets</h3>
                <p className="text-xs text-slate-500">
                  Authorized reference logos, colour palettes, and typography sheets for {orgName}.
                </p>
              </div>
              {canManagePolicies && (
                <button
                  onClick={() => setIsAddingAsset(true)}
                  className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Brand Asset</span>
                </button>
              )}
            </div>

            {isAddingAsset && canManagePolicies && (
              <form onSubmit={handleCreateAsset} className="p-4 rounded-xl bg-slate-50 border border-teal-200 space-y-3">
                <h4 className="text-xs font-bold text-slate-900">Register Approved Brand Asset</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Asset Name</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Primary Monochrome Logo"
                      value={newAsset.asset_name}
                      onChange={(e) => setNewAsset({ ...newAsset, asset_name: e.target.value })}
                      className="w-full text-xs p-2 bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Asset Type</label>
                    <select
                      value={newAsset.asset_type}
                      onChange={(e) => setNewAsset({ ...newAsset, asset_type: e.target.value })}
                      className="w-full text-xs p-2 bg-white border border-slate-200 rounded-md"
                    >
                      <option value="Logo">Logo</option>
                      <option value="Color Palette">Color Palette</option>
                      <option value="Typography">Typography</option>
                    </select>
                  </div>
                </div>

                {newAsset.asset_type === 'Logo' ? (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Upload Reference Logo Image (PNG / JPG / WEBP / SVG)
                    </label>
                    <label className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-slate-300 rounded-md text-xs cursor-pointer hover:bg-slate-100">
                      <ImageIcon className="w-3.5 h-3.5 text-slate-600" />
                      <span>{newAsset.fileName || 'Choose image file'}</span>
                      <input type="file" accept="image/*" onChange={handleAssetImageSelect} className="hidden" />
                    </label>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      {newAsset.asset_type === 'Color Palette'
                        ? 'Hex Codes (comma separated)'
                        : 'Approved Font Families'}
                    </label>
                    <input
                      type="text"
                      placeholder={
                        newAsset.asset_type === 'Color Palette'
                          ? '#0F172A, #0D9488, #F8FAFC'
                          : 'Plus Jakarta Sans, JetBrains Mono'
                      }
                      value={newAsset.file_path}
                      onChange={(e) => setNewAsset({ ...newAsset, file_path: e.target.value })}
                      className="w-full text-xs p-2 bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Usage Guidelines</label>
                  <input
                    type="text"
                    placeholder="Minimum clear space, contrast rules, or weight usage..."
                    value={newAsset.guidelines}
                    onChange={(e) => setNewAsset({ ...newAsset, guidelines: e.target.value })}
                    className="w-full text-xs p-2 bg-white border border-slate-200 rounded-md"
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsAddingAsset(false)}
                    className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded-md"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 rounded-md"
                  >
                    Save Asset
                  </button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {assets.map((asset) => {
                const hexTokens =
                  asset.asset_type === 'Color Palette'
                    ? asset.file_path
                        .split(',')
                        .map((h) => h.trim())
                        .filter((h) => /^#[0-9a-fA-F]{3,8}$/.test(h))
                    : [];

                return (
                  <div
                    key={asset.id}
                    className="border border-slate-200 rounded-lg p-4 bg-slate-50/50 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-1">
                        <span>
                          {asset.asset_type} · {asset.id}
                        </span>
                        {canManagePolicies && (
                          <button
                            onClick={() =>
                              setConfirmDelete({ type: 'asset', id: asset.id, label: asset.asset_name })
                            }
                            className="text-slate-400 hover:text-rose-600 transition-colors p-1"
                            title="Delete Asset"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="font-bold text-sm text-slate-900 mb-2">{asset.asset_name}</div>

                      {asset.asset_type === 'Logo' && (
                        <div className="h-32 bg-white rounded border border-slate-200 flex items-center justify-center p-3 mb-3">
                          <img
                            src={asset.file_path}
                            alt={asset.asset_name}
                            className="max-h-full max-w-full object-contain"
                            referrerPolicy="no-referrer"
                          />
                        </div>
                      )}

                      {asset.asset_type === 'Color Palette' && (
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                          {(hexTokens.length > 0 ? hexTokens : ['#0F172A', '#0D9488', '#F8FAFC']).map((hex) => (
                            <div key={hex} className="flex flex-col items-center gap-1">
                              <div
                                className="w-10 h-10 rounded border border-slate-300"
                                style={{ backgroundColor: hex }}
                                title={hex}
                              />
                              <span className="text-[10px] font-mono text-slate-500">{hex}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {asset.asset_type === 'Typography' && (
                        <div className="p-3 bg-white rounded border border-slate-200 mb-3 space-y-1">
                          <div className="text-sm font-bold font-sans text-slate-900">{asset.file_path}</div>
                        </div>
                      )}

                      <p className="text-xs text-slate-600 leading-relaxed">{asset.guidelines}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* SECTION 5: POLICY DOCUMENTS & RAG INDEX + EVIDENCE SEARCH */}
      {activeSection === 'upload_doc' && (
        <div className="space-y-5">
          {/* Upload & Index Panel */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Database className="w-4 h-4 text-teal-600" />
                  <span>Policy Document Ingestion & RAG Vector Index</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Upload PDF, DOCX, or TXT brand manuals to store persistently, chunk by page/section, embed, and
                  retrieve as cited evidence during content reviews.
                </p>
              </div>
            </div>

            <div className="border-2 border-dashed border-slate-300 hover:border-teal-500 rounded-xl p-6 text-center bg-slate-50/50 transition-colors">
              <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2.5" />
              <div className="text-sm font-semibold text-slate-800 mb-1">
                Upload Policy Document (.pdf, .docx, .txt — max 15MB)
              </div>
              <p className="text-xs text-slate-500 mb-4">
                SHA-256 deduplication prevents duplicate indexing. Scanned PDFs trigger Gemini OCR when configured.
              </p>

              <div className="flex flex-wrap items-center justify-center gap-3">
                {canManagePolicies && (
                  <label className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-lg cursor-pointer transition-colors">
                    <Database className="w-4 h-4" />
                    <span>{isIndexingDoc ? 'Indexing Document...' : 'Ingest & Index into RAG'}</span>
                    <input
                      type="file"
                      disabled={isIndexingDoc}
                      accept=".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={handleRagIngestUpload}
                      className="hidden"
                    />
                  </label>
                )}

                <label className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg cursor-pointer transition-colors">
                  <FileText className="w-4 h-4" />
                  <span>{isExtracting ? 'Extracting Text...' : 'Inspect Raw Text Only'}</span>
                  <input
                    type="file"
                    disabled={isExtracting}
                    accept=".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={handleInspectRawTextOnly}
                    className="hidden"
                  />
                </label>
              </div>

              {uploadedFile && (
                <div className="mt-4 text-xs text-slate-700 font-medium">
                  Last selected: <span className="font-semibold text-slate-900">{uploadedFile.name}</span> (
                  {(uploadedFile.size / 1024).toFixed(1)} KB)
                </div>
              )}
            </div>

            {(isExtracting || isIndexingDoc) && (
              <div className="p-4 rounded-lg bg-teal-50 text-teal-800 text-xs flex items-center gap-2 border border-teal-200">
                <div className="w-3.5 h-3.5 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
                <span>
                  {isIndexingDoc
                    ? 'Parsing pages, chunking guidelines, and building persistent RAG embeddings...'
                    : 'Extracting document text using parser engine...'}
                </span>
              </div>
            )}

            {extractError && (
              <div className="p-4 rounded-lg bg-rose-50 text-rose-800 text-xs flex items-center gap-2 border border-rose-200">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{extractError}</span>
              </div>
            )}

            {docParseWarnings.length > 0 && (
              <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>Document Processing Notice</span>
                </div>
                {docParseWarnings.map((w, idx) => (
                  <p key={idx}>{w}</p>
                ))}
              </div>
            )}

            {extractedDocText && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Extracted Document Text Preview ({extractedDocText.length} characters)
                  </h4>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(extractedDocText);
                      showToast('Extracted text copied to clipboard.');
                    }}
                    className="text-xs text-teal-700 hover:text-teal-800 font-semibold"
                  >
                    Copy Extracted Text
                  </button>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 text-xs font-mono text-slate-800 max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                  {extractedDocText}
                </div>
              </div>
            )}
          </div>

          {/* Indexed Documents Registry */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Indexed Policy Documents ({ragDocuments.length})
                </h3>
                <p className="text-xs text-slate-500">
                  Persistent tenant-isolated policy corpus searched automatically on every compliance review.
                </p>
              </div>
            </div>

            {loadingRagDocs ? (
              <div className="text-xs text-slate-500 py-4">Loading indexed policy corpus...</div>
            ) : ragDocuments.length === 0 ? (
              <div className="p-6 rounded-lg bg-slate-50 border border-slate-200 text-center text-xs text-slate-500">
                No uploaded policy documents are indexed yet for {orgName}. Structured guidelines, facts, and
                terminology rules are still searched, or upload a PDF/DOCX/TXT policy handbook above.
              </div>
            ) : (
              <div className="space-y-3">
                {ragDocuments.map((doc) => {
                  const statusStyle =
                    doc.indexing_status === 'indexed'
                      ? 'bg-teal-50 text-teal-800 border-teal-200'
                      : doc.indexing_status === 'partial_ocr_needed'
                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : 'bg-rose-50 text-rose-800 border-rose-200';

                  return (
                    <div
                      key={doc.id}
                      className="p-4 rounded-lg border border-slate-200 bg-slate-50/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <FileText className="w-4 h-4 text-teal-600 shrink-0" />
                          <span className="text-sm font-bold text-slate-900">{doc.filename}</span>
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${statusStyle}`}>
                            {doc.indexing_status === 'indexed'
                              ? 'Indexed'
                              : doc.indexing_status === 'partial_ocr_needed'
                                ? 'OCR Needed'
                                : 'Failed'}
                          </span>
                          {doc.ocr_used && (
                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                              OCR Applied
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono flex flex-wrap items-center gap-2">
                          <span>{doc.id}</span>
                          <span>·</span>
                          <span>{doc.page_count} page(s)</span>
                          <span>·</span>
                          <span>{doc.chunk_count} chunk(s)</span>
                          <span>·</span>
                          <span>{(doc.size_bytes / 1024).toFixed(1)} KB</span>
                          <span>·</span>
                          <span>SHA256: {doc.sha256.slice(0, 12)}…</span>
                        </div>
                        {doc.warnings && doc.warnings.length > 0 && (
                          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1 mt-1">
                            {doc.warnings.join(' ')}
                          </div>
                        )}
                      </div>

                      {canManagePolicies && (
                        <button
                          onClick={() =>
                            setConfirmDelete({ type: 'rag_doc', id: doc.id, label: doc.filename })
                          }
                          className="px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-md flex items-center gap-1 self-start sm:self-center shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Remove</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Test Evidence Retrieval Tool */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-teal-600" />
                <span>Test Hybrid Evidence Retrieval (BM25 + Embeddings)</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Query {orgName}'s indexed policy chunks, structured guidelines, verified facts, and terminology rules.
              </p>
            </div>

            <form onSubmit={handleTestRagSearch} className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={ragSearchQuery}
                  onChange={(e) => setRagSearchQuery(e.target.value)}
                  placeholder="Enter claim, phrase, or policy topic (e.g. 'founded in 2018' or 'uptime SLA')..."
                  className="w-full text-xs pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <button
                type="submit"
                disabled={isSearchingRag || !ragSearchQuery.trim()}
                className="px-4 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg disabled:opacity-50 shrink-0"
              >
                {isSearchingRag ? 'Searching...' : 'Retrieve Evidence'}
              </button>
            </form>

            {ragSearchResult && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
                  <span>
                    Searched: <strong>{ragSearchResult.searched_chunks}</strong> doc chunks,{' '}
                    <strong>{ragSearchResult.searched_guidelines}</strong> guidelines,{' '}
                    <strong>{ragSearchResult.searched_facts}</strong> facts
                  </span>
                  <span>·</span>
                  <span>
                    Top match score: <strong>{Math.round(ragSearchResult.max_score * 100)}%</strong>
                  </span>
                </div>

                {ragSearchResult.missing_evidence_warning && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>
                      {ragSearchResult.warning_message ||
                        'No strong supporting policy evidence was retrieved for this query.'}
                    </span>
                  </div>
                )}

                {ragSearchResult.items.length === 0 ? (
                  <div className="text-xs text-slate-500 py-2">No matching passages found in {orgName}.</div>
                ) : (
                  <div className="space-y-2">
                    {ragSearchResult.items.map((item) => (
                      <div key={item.id} className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-slate-900 text-white font-semibold uppercase text-[10px]">
                              {item.source_type.replace('_', ' ')}
                            </span>
                            <span className="font-bold text-slate-900">{item.source_document}</span>
                            <span className="text-slate-500">· {item.page_or_section}</span>
                          </div>
                          <span className="font-mono text-teal-800 font-semibold">
                            Score {Math.round(item.score * 100)}% (vec {Math.round(item.vector_score * 100)}% / kw{' '}
                            {Math.round(item.keyword_score * 100)}%)
                          </span>
                        </div>
                        <p className="text-xs text-slate-700 leading-relaxed">{item.excerpt}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
