import React, { useState, useEffect } from 'react';
import {
  FileSearch,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Check,
  X,
  Edit3,
  Send,
  Upload,
  HelpCircle,
  Layers,
  Eye,
  FileCheck2,
  Cpu,
  BookMarked,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
} from 'lucide-react';
import {
  Submission,
  ComplianceIssue,
  ContentType,
  ContentVersion,
  SubmissionComment,
  UserRole,
  RetrievedEvidenceItem,
  RetrievalSummary,
  VisualAnalysisResult,
} from '../../types';
import { api } from '../../services/api';
import { CommentsThread } from './CommentsThread';
import { VisualGovernancePanel } from './VisualGovernancePanel';

interface ContentReviewProps {
  initialSubmissionId?: string;
  currentUserId?: string;
  userRole: UserRole;
  orgName: string;
  onSubmissionUpdated?: () => void;
  onNavigateToApproval?: (submissionId: string) => void;
  onNavigateToReport?: (submissionId: string) => void;
}

export const ContentReviewTab: React.FC<ContentReviewProps> = ({
  initialSubmissionId,
  currentUserId,
  userRole,
  orgName,
  onSubmissionUpdated,
  onNavigateToApproval,
  onNavigateToReport,
}) => {
  const [title, setTitle] = useState('');
  const [contentType, setContentType] = useState<ContentType>('Social Media');
  const [content, setContent] = useState('');
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(initialSubmissionId || null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const [activeSubmission, setActiveSubmission] = useState<Submission | null>(null);
  const [issues, setIssues] = useState<ComplianceIssue[]>([]);
  const [versions, setVersions] = useState<ContentVersion[]>([]);
  const [comments, setComments] = useState<SubmissionComment[]>([]);
  const [usedAI, setUsedAI] = useState<boolean | null>(null);
  const [overallSummary, setOverallSummary] = useState<string>('');
  const [retrievedEvidence, setRetrievedEvidence] = useState<RetrievedEvidenceItem[]>([]);
  const [retrievalSummary, setRetrievalSummary] = useState<RetrievalSummary | null>(null);
  const [showRetrievedPanel, setShowRetrievedPanel] = useState(false);
  const [expandedIssueExcerpts, setExpandedIssueExcerpts] = useState<Record<string, boolean>>({});
  const [reviewSurface, setReviewSurface] = useState<'copy' | 'visual'>('copy');
  const [visualAnalyses, setVisualAnalyses] = useState<VisualAnalysisResult[]>([]);

  const [viewMode, setViewMode] = useState<'editor' | 'compare'>('editor');
  const [editingIssueId, setEditingIssueId] = useState<string | null>(null);
  const [customCorrection, setCustomCorrection] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialSubmissionId) {
      loadSubmission(initialSubmissionId);
    } else {
      setActiveSubmission(null);
      setActiveSubmissionId(null);
      setIssues([]);
      setVersions([]);
      setComments([]);
      setVisualAnalyses([]);
      setRetrievedEvidence([]);
      setRetrievalSummary(null);
    }
  }, [initialSubmissionId]);

  const loadSubmission = async (id: string) => {
    try {
      const data = await api.getSubmissionDetails(id);
      setActiveSubmission(data.submission);
      setActiveSubmissionId(data.submission.id);
      setTitle(data.submission.title);
      setContentType(data.submission.content_type);
      setContent(data.submission.content);
      setIssues(data.issues);
      setVersions(data.versions);
      setComments(data.comments || []);
      setVisualAnalyses(data.visual_analyses || []);
    } catch (err: any) {
      console.error('Failed to load submission:', err);
      setAnalysisError(err.message || 'Unable to load submission.');
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const canEditSubmission =
    !activeSubmission ||
    ((activeSubmission.created_by === currentUserId || userRole === 'admin') &&
      ['Draft', 'Needs Revision'].includes(activeSubmission.status));

  const handleStartNewDraft = () => {
    setTitle('');
    setContentType('Social Media');
    setContent('');
    setActiveSubmission(null);
    setActiveSubmissionId(null);
    setIssues([]);
    setVersions([]);
    setComments([]);
    setVisualAnalyses([]);
    setRetrievedEvidence([]);
    setRetrievalSummary(null);
    setOverallSummary('');
    setUsedAI(null);
    setAnalysisError(null);
  };

  const handlePreloadDemoContent = () => {
    setTitle('Spring Launch Omni-Suite Promo Copy');
    setContentType('Social Media');
    setContent('We are the best ever! Our product guarantees results. Trusted by 50,000 customers. Buy now or miss out!');
    setActiveSubmission(null);
    setActiveSubmissionId(null);
    setIssues([]);
    setVersions([]);
    setComments([]);
    setRetrievedEvidence([]);
    setRetrievalSummary(null);
    setAnalysisError(null);
    showToast('Loaded benchmark test copy.');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(',')[1];
          const result = await api.parseDocument(base64, file.name, file.type);
          setContent(result.text);
          if (!title) {
            setTitle(file.name.replace(/\.[^/.]+$/, ''));
          }
          showToast(`Extracted ${result.text.length} characters from ${file.name}`);
        } catch (err: any) {
          setAnalysisError(err.message || 'Error extracting document.');
        }
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      setAnalysisError(err.message || 'Failed reading file.');
    }
  };

  const handleAnalyze = async () => {
    if (!content.trim()) {
      setAnalysisError('Please enter or paste text to analyze.');
      return;
    }

    setIsAnalyzing(true);
    setAnalysisError(null);

    try {
      const result = await api.analyzeContent({
        title: title || 'Marketing Content Draft',
        content,
        content_type: contentType,
        submission_id: activeSubmissionId || undefined,
      });

      setActiveSubmission(result.submission);
      setActiveSubmissionId(result.submission.id);
      setIssues(result.issues);
      setUsedAI(result.used_ai);
      setOverallSummary(result.overall_summary);
      setRetrievedEvidence(result.retrieved_evidence || []);
      setRetrievalSummary(result.retrieval_summary || null);

      const details = await api.getSubmissionDetails(result.submission.id);
      setVersions(details.versions);
      setComments(details.comments || []);
      setVisualAnalyses(details.visual_analyses || []);

      showToast(`Analysis complete: Found ${result.issues.length} evidence-grounded item(s).`);
      onSubmissionUpdated?.();
    } catch (err: any) {
      setAnalysisError(err.message || 'Failed to complete compliance analysis.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const replaceProblematicPhrase = (source: string, target: string, replacement: string): string => {
    if (!target) return source;
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    return source.replace(regex, replacement);
  };

  const handleApplySingleCorrection = async (issue: ComplianceIssue, replacementText: string) => {
    if (!activeSubmission || !canEditSubmission) return;
    setAnalysisError(null);

    try {
      const updatedContent = replaceProblematicPhrase(content, issue.problematic_text, replacementText);
      setContent(updatedContent);

      await api.updateIssueStatus(activeSubmission.id, issue.id, 'Accepted', replacementText);
      const res = await api.updateContent(
        activeSubmission.id,
        updatedContent,
        undefined,
        `Applied correction for "${issue.problematic_text}"`
      );
      setActiveSubmission(res.submission);

      const details = await api.getSubmissionDetails(activeSubmission.id);
      setVersions(details.versions);
      setIssues((prev) =>
        prev.map((i) => (i.id === issue.id ? { ...i, human_status: 'Accepted', suggested_correction: replacementText } : i))
      );

      showToast(`Applied correction: "${issue.problematic_text}" → "${replacementText}"`);
      onSubmissionUpdated?.();
    } catch (err: any) {
      setAnalysisError(err.message || 'Failed to apply correction.');
    }
  };

  const handleRejectIssue = async (issue: ComplianceIssue) => {
    if (!activeSubmission || !canEditSubmission) return;
    try {
      await api.updateIssueStatus(activeSubmission.id, issue.id, 'Rejected');
      setIssues((prev) =>
        prev.map((i) => (i.id === issue.id ? { ...i, human_status: 'Rejected' } : i))
      );
      showToast('Flag dismissed by creator.');
    } catch (err: any) {
      setAnalysisError(err.message || 'Failed to dismiss issue.');
    }
  };

  const handleApplyAllCorrections = async () => {
    if (!activeSubmission || !canEditSubmission) return;
    setAnalysisError(null);

    try {
      let newContent = content;
      for (const issue of issues) {
        if (issue.human_status !== 'Rejected' && issue.suggested_correction) {
          newContent = replaceProblematicPhrase(newContent, issue.problematic_text, issue.suggested_correction);
          await api.updateIssueStatus(activeSubmission.id, issue.id, 'Accepted');
        }
      }

      setContent(newContent);
      const res = await api.updateContent(
        activeSubmission.id,
        newContent,
        undefined,
        'Applied all recommended corrections'
      );
      setActiveSubmission(res.submission);

      const details = await api.getSubmissionDetails(activeSubmission.id);
      setVersions(details.versions);
      setIssues((prev) =>
        prev.map((i) => (i.human_status !== 'Rejected' ? { ...i, human_status: 'Accepted' } : i))
      );

      showToast('Applied all recommended brand corrections.');
      onSubmissionUpdated?.();
    } catch (err: any) {
      setAnalysisError(err.message || 'Failed to apply corrections.');
    }
  };

  const handleSubmitForApproval = async () => {
    if (!activeSubmission) return;
    setAnalysisError(null);
    try {
      await api.submitForReview(activeSubmission.id);
      showToast('Content submitted for Brand Manager review.');
      onSubmissionUpdated?.();
      if (onNavigateToApproval) {
        onNavigateToApproval(activeSubmission.id);
      }
    } catch (err: any) {
      setAnalysisError(err.message || 'Failed to submit for approval.');
    }
  };

  return (
    <div className="space-y-6">
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900 text-white px-4 py-3 rounded-lg shadow-lg border border-teal-500/40 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-teal-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Banner & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <FileSearch className="w-5 h-5 text-teal-600" />
              <span>Content Review & Compliance Scanner</span>
            </h2>
            {activeSubmission && (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700 font-mono">
                {activeSubmission.id}
              </span>
            )}
            {usedAI !== null && (
              <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-teal-50 text-teal-800 border border-teal-200 flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                <span>{usedAI ? 'Gemini AI Engine' : 'Deterministic Rule Fallback'}</span>
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Compliance checks scoped to {orgName} guidelines, verified facts, and prohibited terminology
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg text-xs font-medium mr-1">
            <button
              onClick={() => setReviewSurface('copy')}
              className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 ${
                reviewSurface === 'copy'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileSearch className="w-3.5 h-3.5 text-teal-600" />
              <span>Copy & RAG Scan</span>
            </button>
            <button
              onClick={() => setReviewSurface('visual')}
              className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 ${
                reviewSurface === 'visual'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5 text-teal-600" />
              <span>Visual & WCAG ({visualAnalyses.length})</span>
            </button>
          </div>

          {activeSubmission && (
            <button
              onClick={handleStartNewDraft}
              className="px-3 py-1.5 text-xs font-medium bg-white text-slate-700 hover:bg-slate-50 border border-slate-300 rounded-lg transition-colors"
            >
              New Draft
            </button>
          )}
          <button
            onClick={handlePreloadDemoContent}
            className="px-3.5 py-1.5 text-xs font-semibold bg-teal-50 text-teal-800 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5 text-teal-600" />
            <span>Load Benchmark Copy</span>
          </button>

          <label className="px-3.5 py-1.5 text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 rounded-lg cursor-pointer transition-colors flex items-center gap-1.5">
            <Upload className="w-3.5 h-3.5 text-slate-600" />
            <span>Upload Document</span>
            <input
              type="file"
              accept=".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {reviewSurface === 'visual' ? (
        <VisualGovernancePanel
          submissionId={activeSubmissionId}
          orgName={orgName}
          canEdit={canEditSubmission}
          initialAnalyses={activeSubmissionId ? visualAnalyses : undefined}
          onAnalysisCompleted={(va) => setVisualAnalyses((prev) => [va, ...prev])}
        />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Content Input & Editor (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Content Title</label>
                <input
                  type="text"
                  disabled={!canEditSubmission}
                  placeholder="e.g. Q1 Global Cloud Launch Copy"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Content Channel</label>
                <select
                  disabled={!canEditSubmission}
                  value={contentType}
                  onChange={(e) => setContentType(e.target.value as ContentType)}
                  className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-60"
                >
                  <option value="Social Media">Social Media</option>
                  <option value="Email Campaign">Email Campaign</option>
                  <option value="Advertisement">Advertisement</option>
                  <option value="Website Copy">Website Copy</option>
                  <option value="Press Release">Press Release</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="text-[11px] font-semibold text-slate-700">
                Draft Content Text ({content.length} chars)
              </label>

              {activeSubmission && (
                <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded text-[11px]">
                  <button
                    onClick={() => setViewMode('editor')}
                    className={`px-2 py-0.5 rounded font-medium ${
                      viewMode === 'editor' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
                    }`}
                  >
                    Editor
                  </button>
                  <button
                    onClick={() => setViewMode('compare')}
                    className={`px-2 py-0.5 rounded font-medium flex items-center gap-1 ${
                      viewMode === 'compare' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    <span>Compare Original vs Current</span>
                  </button>
                </div>
              )}
            </div>

            {viewMode === 'editor' ? (
              <textarea
                rows={10}
                disabled={!canEditSubmission}
                placeholder="Paste marketing copy, press statement, product claim, or website text here to analyze against brand rules..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full text-xs font-mono p-3.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 leading-relaxed disabled:opacity-75"
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono bg-slate-50 p-3 rounded-lg border border-slate-200">
                <div>
                  <div className="text-[11px] font-bold uppercase text-slate-500 mb-1.5">Original Submission</div>
                  <div className="p-2.5 bg-white rounded border border-slate-200 text-slate-600 leading-relaxed min-h-[140px] whitespace-pre-wrap">
                    {activeSubmission?.original_content || content}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-bold uppercase text-teal-700 mb-1.5">Current Revised Version</div>
                  <div className="p-2.5 bg-teal-50/50 rounded border border-teal-200 text-teal-950 leading-relaxed min-h-[140px] whitespace-pre-wrap">
                    {content}
                  </div>
                </div>
              </div>
            )}

            {analysisError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{analysisError}</span>
              </div>
            )}

            {/* Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              {canEditSubmission ? (
                <button
                  onClick={handleAnalyze}
                  disabled={isAnalyzing}
                  className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded-lg transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
                >
                  {isAnalyzing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Auditing against brand rules...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 text-teal-400" />
                      <span>ANALYSE CONTENT</span>
                    </>
                  )}
                </button>
              ) : (
                <div className="text-xs text-slate-500 italic">
                  Editing locked while submission is in "{activeSubmission?.status}" status or owned by another user.
                </div>
              )}

              {activeSubmission && (
                <div className="flex flex-wrap items-center gap-2">
                  {onNavigateToReport && (
                    <button
                      onClick={() => onNavigateToReport(activeSubmission.id)}
                      className="px-3 py-2 text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <FileCheck2 className="w-3.5 h-3.5" />
                      <span>View Report</span>
                    </button>
                  )}

                  {canEditSubmission && issues.length > 0 && issues.some((i) => i.human_status === 'Pending') && (
                    <button
                      onClick={handleApplyAllCorrections}
                      className="px-3 py-2 text-xs font-medium bg-teal-50 text-teal-800 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Apply All Corrections</span>
                    </button>
                  )}

                  {canEditSubmission && (
                    <button
                      onClick={handleSubmitForApproval}
                      className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white font-semibold text-xs rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Send for Manager Approval</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Version History Drawer */}
          {versions.length > 0 && (
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm text-xs">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-slate-500" />
                  <span>Revision History ({versions.length} versions)</span>
                </div>
                <span className="text-[11px] text-slate-400">Immutable version snapshots</span>
              </div>
              <div className="space-y-1.5">
                {versions.map((ver) => (
                  <div
                    key={ver.id}
                    className="flex items-center justify-between gap-3 p-2.5 rounded bg-slate-50 hover:bg-slate-100 transition-colors text-slate-700"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-900">v{ver.version_number}</span>
                        {ver.author_name && <span className="text-slate-600 font-medium">{ver.author_name}</span>}
                        {ver.compliance_score !== undefined && ver.compliance_score !== null && (
                          <span className="font-mono text-[11px] text-teal-700 font-semibold">
                            {ver.compliance_score}%
                          </span>
                        )}
                        <span className="text-slate-400 font-mono text-[11px]">
                          {new Date(ver.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {ver.change_summary || ver.content.slice(0, 60)}
                      </div>
                    </div>
                    {canEditSubmission && (
                      <button
                        onClick={() => setContent(ver.content)}
                        className="text-[11px] font-medium text-teal-700 hover:underline shrink-0"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Collaborative Comments */}
          {activeSubmission && (
            <CommentsThread
              submissionId={activeSubmission.id}
              comments={comments}
              onCommentAdded={(newC) => setComments((prev) => [...prev, newC])}
            />
          )}
        </div>

        {/* Right Column: Compliance Findings & Corrections (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          {activeSubmission ? (
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Compliance Score
                  </div>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span
                      className={`text-3xl font-extrabold font-mono tabular-nums ${
                        activeSubmission.compliance_score >= 80
                          ? 'text-teal-600'
                          : activeSubmission.compliance_score >= 50
                          ? 'text-amber-600'
                          : 'text-rose-600'
                      }`}
                    >
                      {activeSubmission.compliance_score}%
                    </span>
                    <span className="text-xs text-slate-500 font-medium">/ 100</span>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-[11px] font-semibold text-slate-500">Submission Status</div>
                  <span
                    className={`inline-block px-2.5 py-1 rounded text-xs font-bold mt-1 ${
                      activeSubmission.status === 'Approved'
                        ? 'bg-teal-50 text-teal-700 border border-teal-200'
                        : activeSubmission.status === 'In Review'
                        ? 'bg-blue-50 text-blue-700 border border-blue-200'
                        : activeSubmission.status === 'Needs Revision'
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : activeSubmission.status === 'Rejected'
                        ? 'bg-rose-50 text-rose-700 border border-rose-200'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {activeSubmission.status}
                  </span>
                </div>
              </div>

              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 text-[11px] text-slate-500 flex items-start gap-1.5">
                <HelpCircle className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Internal Heuristic Score:</strong> Indicates alignment with current {orgName} guidelines.
                  It does not replace human editorial sign-off.
                </span>
              </div>

              {overallSummary && <p className="text-xs text-slate-600 leading-relaxed pt-1">{overallSummary}</p>}
            </div>
          ) : (
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm text-center py-10">
              <FileSearch className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <div className="text-sm font-semibold text-slate-800">Ready for Content Review</div>
              <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                Paste copy on the left and click <strong>ANALYSE CONTENT</strong> to audit against {orgName} guidelines and facts.
              </p>
            </div>
          )}

          {retrievalSummary && (
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="font-bold text-slate-800 flex items-center gap-1.5">
                  <BookMarked className="w-4 h-4 text-teal-600" />
                  <span>RAG Evidence Retrieval</span>
                </div>
                <span className="font-mono text-[11px] text-slate-500">
                  {retrievalSummary.searched_chunks} doc chunks · {retrievalSummary.searched_guidelines} rules ·{' '}
                  {retrievalSummary.searched_facts} facts
                </span>
              </div>

              {retrievalSummary.missing_evidence_warning && (
                <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <span>{retrievalSummary.warning_message}</span>
                </div>
              )}

              {retrievedEvidence.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowRetrievedPanel((p) => !p)}
                    className="text-[11px] font-semibold text-teal-700 hover:text-teal-800 flex items-center gap-1"
                  >
                    <span>
                      {showRetrievedPanel ? 'Hide' : 'Inspect'} Retrieved Passages ({retrievedEvidence.length})
                    </span>
                    {showRetrievedPanel ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>

                  {showRetrievedPanel && (
                    <div className="mt-2 space-y-2 max-h-56 overflow-y-auto">
                      {retrievedEvidence.map((ev) => (
                        <div key={ev.id} className="p-2.5 rounded bg-slate-50 border border-slate-200 text-[11px] space-y-1">
                          <div className="flex items-center justify-between gap-2 font-semibold text-slate-800">
                            <span>
                              {ev.source_document} · {ev.page_or_section}
                            </span>
                            <span className="font-mono text-teal-700">{Math.round(ev.score * 100)}% match</span>
                          </div>
                          <div className="text-slate-600 italic leading-relaxed">"{ev.excerpt}"</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {issues.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                <span>Detected Governance Issues ({issues.length})</span>
                <span className="text-[11px] text-slate-400 font-normal">
                  {issues.filter((i) => i.human_status === 'Accepted').length} of {issues.length} resolved
                </span>
              </div>

              {issues.map((issue) => {
                let sevStyle = 'bg-amber-50 text-amber-800 border-amber-200';
                if (issue.severity === 'High') sevStyle = 'bg-rose-50 text-rose-800 border-rose-200';
                else if (issue.severity === 'Low') sevStyle = 'bg-blue-50 text-blue-800 border-blue-200';

                const evStatus = issue.evidence_status || (issue.confidence === 'Unverified' ? 'Unverified' : 'Contradicted');
                const evBadgeStyle =
                  evStatus === 'Supported'
                    ? 'bg-teal-50 text-teal-800 border-teal-200'
                    : evStatus === 'Contradicted'
                    ? 'bg-rose-50 text-rose-800 border-rose-200'
                    : 'bg-amber-50 text-amber-800 border-amber-200';

                const isResolved = issue.human_status === 'Accepted';
                const isRejected = issue.human_status === 'Rejected';
                const isExcerptOpen = Boolean(expandedIssueExcerpts[issue.id]);

                return (
                  <div
                    key={issue.id}
                    className={`bg-white rounded-xl border p-4 shadow-sm transition-all ${
                      isResolved
                        ? 'border-teal-200 bg-teal-50/20'
                        : isRejected
                        ? 'border-slate-200 opacity-60'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                          <span className="font-semibold text-slate-700">{issue.category}</span>
                          <span>·</span>
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${evBadgeStyle}`}>
                            {evStatus}
                          </span>
                          <span>·</span>
                          <span className="font-mono text-slate-600">
                            Confidence: {issue.confidence_score !== undefined ? `${issue.confidence_score}%` : issue.confidence}
                          </span>
                        </div>
                        <h4 className="text-xs font-bold text-slate-900 mt-1">{issue.title}</h4>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase shrink-0 ${sevStyle}`}>
                        {issue.severity}
                      </span>
                    </div>

                    <div className="p-2 rounded bg-rose-50/70 border border-rose-100 text-xs text-rose-950 font-mono mb-2">
                      <span className="text-[10px] uppercase font-bold text-rose-700 block font-sans mb-0.5">
                        Flagged Phrase:
                      </span>
                      "{issue.problematic_text}"
                    </div>

                    <p className="text-xs text-slate-600 leading-relaxed mb-2.5">{issue.explanation}</p>

                    {(issue.source_document || issue.supporting_guideline_excerpt) && (
                      <div className="mb-2.5 p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-700 flex items-center gap-1 truncate">
                            <BookMarked className="w-3 h-3 text-teal-600 shrink-0" />
                            <span className="truncate">
                              {issue.source_document || 'Brand Policy'}
                              {issue.page_or_section ? ` · ${issue.page_or_section}` : ''}
                            </span>
                          </span>
                          {issue.supporting_guideline_excerpt && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedIssueExcerpts((prev) => ({ ...prev, [issue.id]: !isExcerptOpen }))
                              }
                              className="text-[10px] font-semibold text-teal-700 hover:underline shrink-0"
                            >
                              {isExcerptOpen ? 'Hide Passage' : 'Inspect Guideline Passage'}
                            </button>
                          )}
                        </div>
                        {isExcerptOpen && issue.supporting_guideline_excerpt && (
                          <div className="pt-1 text-slate-600 italic leading-relaxed border-t border-slate-200">
                            "{issue.supporting_guideline_excerpt}"
                          </div>
                        )}
                      </div>
                    )}

                    <div className="p-2.5 rounded-lg bg-teal-50/60 border border-teal-200 text-xs mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-[11px] uppercase tracking-wider text-teal-900 flex items-center gap-1">
                          <Sparkles className="w-3 h-3 text-teal-600" />
                          <span>Suggested Correction:</span>
                        </span>
                        {canEditSubmission && editingIssueId !== issue.id && !isResolved && (
                          <button
                            onClick={() => {
                              setEditingIssueId(issue.id);
                              setCustomCorrection(issue.suggested_correction);
                            }}
                            className="text-[10px] text-teal-700 hover:underline flex items-center gap-0.5 font-medium"
                          >
                            <Edit3 className="w-2.5 h-2.5" />
                            <span>Edit Suggestion</span>
                          </button>
                        )}
                      </div>

                      {editingIssueId === issue.id ? (
                        <div className="space-y-2 mt-1">
                          <input
                            type="text"
                            value={customCorrection}
                            onChange={(e) => setCustomCorrection(e.target.value)}
                            className="w-full text-xs p-1.5 bg-white border border-teal-300 rounded focus:ring-1 focus:ring-teal-500"
                          />
                          <div className="flex justify-end gap-1.5">
                            <button
                              onClick={() => setEditingIssueId(null)}
                              className="text-[10px] px-2 py-0.5 rounded bg-slate-200 text-slate-700"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => {
                                handleApplySingleCorrection(issue, customCorrection);
                                setEditingIssueId(null);
                              }}
                              className="text-[10px] px-2 py-0.5 rounded bg-teal-600 text-white font-medium"
                            >
                              Apply Custom
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="font-semibold text-teal-950 font-sans">"{issue.suggested_correction}"</div>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
                      <span className="text-[11px] text-slate-400">
                        Status: <strong className="text-slate-700">{issue.human_status}</strong>
                      </span>

                      {canEditSubmission && !isResolved && !isRejected ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleRejectIssue(issue)}
                            className="px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 rounded transition-colors flex items-center gap-1"
                          >
                            <X className="w-3 h-3 text-slate-400" />
                            <span>Dismiss</span>
                          </button>
                          <button
                            onClick={() => handleApplySingleCorrection(issue, issue.suggested_correction)}
                            className="px-3 py-1 text-[11px] font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded transition-colors flex items-center gap-1 shadow-xs"
                          >
                            <Check className="w-3 h-3" />
                            <span>Accept & Apply</span>
                          </button>
                        </div>
                      ) : isResolved ? (
                        <span className="text-[11px] font-semibold text-teal-700 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Correction Applied</span>
                        </span>
                      ) : isRejected ? (
                        <span className="text-[11px] text-slate-400 italic">Dismissed by creator</span>
                      ) : (
                        <span className="text-[11px] text-slate-400 italic">Read-only</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
};
