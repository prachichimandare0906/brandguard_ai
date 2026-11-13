import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  RotateCcw,
  AlertTriangle,
  ArrowRight,
  Lock,
} from 'lucide-react';
import {
  Submission,
  ComplianceIssue,
  ReviewLog,
  SubmissionComment,
  User as UserType,
} from '../../types';
import { api } from '../../services/api';
import { CommentsThread } from '../review/CommentsThread';

interface ApprovalProps {
  submissions: Submission[];
  initialSubmissionId?: string;
  currentUser: UserType | null;
  orgName: string;
  onRefresh: () => void;
  onSelectSubmissionForReview: (subId: string) => void;
}

export const ApprovalCentreTab: React.FC<ApprovalProps> = ({
  submissions,
  initialSubmissionId,
  currentUser,
  orgName,
  onRefresh,
  onSelectSubmissionForReview,
}) => {
  const [selectedSubId, setSelectedSubId] = useState<string>(
    initialSubmissionId || submissions[0]?.id || ''
  );
  const [decision, setDecision] = useState<'Approved' | 'Rejected' | 'Needs Revision'>('Approved');
  const [comments, setComments] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [activeDetails, setActiveDetails] = useState<{
    submission: Submission;
    issues: ComplianceIssue[];
    reviews: ReviewLog[];
    comments: SubmissionComment[];
  } | null>(null);

  useEffect(() => {
    if (initialSubmissionId) {
      setSelectedSubId(initialSubmissionId);
    } else if (!selectedSubId && submissions.length > 0) {
      const firstInReview = submissions.find((s) => s.status === 'In Review');
      setSelectedSubId((firstInReview || submissions[0]).id);
    }
  }, [initialSubmissionId, submissions, selectedSubId]);

  useEffect(() => {
    if (selectedSubId) {
      loadDetails(selectedSubId);
    } else {
      setActiveDetails(null);
    }
  }, [selectedSubId]);

  const loadDetails = async (id: string) => {
    try {
      const data = await api.getSubmissionDetails(id);
      setActiveDetails(data);
    } catch (err) {
      console.error(err);
    }
  };

  const isAuthorizedReviewer =
    currentUser?.role === 'brand_manager' || currentUser?.role === 'admin';

  const sub = activeDetails?.submission;
  const issues = activeDetails?.issues || [];
  const reviews = activeDetails?.reviews || [];
  const threadComments = activeDetails?.comments || [];

  const isSelfAuthored = Boolean(sub && currentUser && sub.created_by === currentUser.id);
  const isInReview = sub?.status === 'In Review';

  const handleMakeDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSubId) return;

    if (!isAuthorizedReviewer) {
      setErrorMsg('Only Brand Managers and Administrators have authority to sign off on reviews.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      await api.reviewSubmission(selectedSubId, decision, comments);
      setSuccessMsg(`Decision "${decision}" recorded and audited.`);
      setComments('');
      await loadDetails(selectedSubId);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Error processing approval decision.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const pendingSubmissions = submissions.filter((s) => s.status === 'In Review');
  const otherSubmissions = submissions.filter((s) => s.status !== 'In Review');

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-teal-600" />
            <span>Brand Manager Approval Centre</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Human-in-the-loop sign-off for {orgName}: inspect findings, discuss with creators, and issue release decisions
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!isAuthorizedReviewer ? (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
              <Lock className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                Signed in as <strong>Creator</strong> (Read-only approval queue). Sign in as a Brand Manager or Administrator to issue decisions.
              </span>
            </div>
          ) : (
            <div className="px-3 py-1.5 rounded-lg bg-teal-50 border border-teal-200 text-xs text-teal-800 font-semibold flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-teal-600" />
              <span>Sign-off Authority Active ({currentUser?.name})</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Submissions Queue (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Awaiting Sign-Off ({pendingSubmissions.length})
              </h3>
              <span className="text-[11px] font-mono text-amber-700 font-semibold">Priority Queue</span>
            </div>

            <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
              {pendingSubmissions.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  No submissions currently in review. Submit content from Content Review.
                </div>
              ) : (
                pendingSubmissions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedSubId(s.id)}
                    className={`w-full text-left p-3.5 hover:bg-slate-50 transition-colors flex items-start justify-between gap-2 ${
                      selectedSubId === s.id ? 'bg-teal-50/50 border-l-4 border-l-teal-600' : ''
                    }`}
                  >
                    <div>
                      <div className="text-xs font-bold text-slate-900 leading-tight">{s.title}</div>
                      <div className="text-[11px] text-slate-400 mt-1">
                        {s.content_type} · {s.author_name}
                      </div>
                    </div>
                    <span className="text-xs font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                      {s.compliance_score}%
                    </span>
                  </button>
                ))
              )}
            </div>

            {otherSubmissions.length > 0 && (
              <>
                <div className="p-3 bg-slate-100 border-t border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  Past / Draft Submissions ({otherSubmissions.length})
                </div>
                <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {otherSubmissions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedSubId(s.id)}
                      className={`w-full text-left p-3 hover:bg-slate-50 transition-colors flex items-center justify-between text-xs ${
                        selectedSubId === s.id ? 'bg-slate-100 font-semibold' : ''
                      }`}
                    >
                      <div className="truncate pr-2">
                        <div className="truncate text-slate-800">{s.title}</div>
                        <div className="text-[10px] text-slate-400">{s.status}</div>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">{s.compliance_score}%</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right Column: Review Workspace & Decision Form (8 cols) */}
        <div className="lg:col-span-8 space-y-4">
          {sub ? (
            <div className="space-y-4">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[11px] font-mono text-slate-400">
                      {sub.id} · {sub.content_type} · Status: {sub.status}
                    </span>
                    <h3 className="text-lg font-bold text-slate-900 mt-0.5">{sub.title}</h3>
                    <div className="text-xs text-slate-500 mt-1">
                      Submitted by <strong>{sub.author_name || 'Creator'}</strong> on{' '}
                      {new Date(sub.created_at).toLocaleDateString()}
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-2xl font-extrabold font-mono text-teal-600 tabular-nums">
                      {sub.compliance_score}%
                    </span>
                    <div className="text-[11px] text-slate-400">Heuristic Score</div>
                  </div>
                </div>

                <div className="p-3.5 bg-slate-50 rounded-lg border border-slate-200 text-xs font-mono text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {sub.content}
                </div>

                <div className="flex items-center justify-between text-xs pt-1">
                  <span className="text-slate-500">
                    Flagged items: <strong className="text-slate-800">{issues.length}</strong> (
                    {issues.filter((i) => i.human_status === 'Accepted').length} corrections applied)
                  </span>
                  <button
                    onClick={() => onSelectSubmissionForReview(sub.id)}
                    className="text-teal-700 hover:text-teal-800 font-semibold flex items-center gap-1"
                  >
                    <span>Open in Content Editor</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Decision Panel */}
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                  Managerial Sign-off & Audit Decision
                </h4>

                {isSelfAuthored && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>
                      <strong>Separation of Duties Enforced:</strong> You created this submission, so another Brand Manager or Administrator must issue the final review decision.
                    </span>
                  </div>
                )}

                {!isInReview && (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600">
                    This submission is currently in <strong>{sub.status}</strong> status. Creators must send drafts for review before sign-off.
                  </div>
                )}

                {errorMsg && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800">
                    {errorMsg}
                  </div>
                )}

                {successMsg && (
                  <div className="p-3 bg-teal-50 border border-teal-200 rounded text-xs text-teal-800 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-teal-600" />
                    <span>{successMsg}</span>
                  </div>
                )}

                <form onSubmit={handleMakeDecision} className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">Decision Action</label>
                    <div className="grid grid-cols-3 gap-3">
                      <button
                        type="button"
                        onClick={() => setDecision('Approved')}
                        className={`p-3 rounded-lg border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all ${
                          decision === 'Approved'
                            ? 'bg-teal-50 border-teal-500 text-teal-800 ring-2 ring-teal-500'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <CheckCircle2 className="w-4 h-4 text-teal-600" />
                        <span>Approve Content</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDecision('Needs Revision')}
                        className={`p-3 rounded-lg border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all ${
                          decision === 'Needs Revision'
                            ? 'bg-amber-50 border-amber-500 text-amber-800 ring-2 ring-amber-500'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <RotateCcw className="w-4 h-4 text-amber-600" />
                        <span>Request Revision</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDecision('Rejected')}
                        className={`p-3 rounded-lg border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all ${
                          decision === 'Rejected'
                            ? 'bg-rose-50 border-rose-500 text-rose-800 ring-2 ring-rose-500'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <XCircle className="w-4 h-4 text-rose-600" />
                        <span>Reject Submission</span>
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Managerial Audit Comments & Feedback
                    </label>
                    <textarea
                      rows={3}
                      required={decision !== 'Approved'}
                      placeholder="Add compliance notes, rationale, or instructions for creator revisions..."
                      value={comments}
                      onChange={(e) => setComments(e.target.value)}
                      className="w-full text-xs p-3 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={isSubmitting || !isAuthorizedReviewer || isSelfAuthored || !isInReview}
                      className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded-lg transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      <ShieldCheck className="w-4 h-4 text-teal-400" />
                      <span>{isSubmitting ? 'Recording Decision...' : 'Commit Governance Decision'}</span>
                    </button>
                  </div>
                </form>
              </div>

              {/* Threaded Collaboration Comments */}
              <CommentsThread
                submissionId={sub.id}
                comments={threadComments}
                onCommentAdded={(newC) =>
                  setActiveDetails((prev) =>
                    prev ? { ...prev, comments: [...prev.comments, newC] } : prev
                  )
                }
              />

              {/* Decision History Trail */}
              {reviews.length > 0 && (
                <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Decision History Trail
                  </h4>
                  <div className="space-y-2">
                    {reviews.map((r) => (
                      <div key={r.id} className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-slate-800">
                            {r.reviewer_name} ({r.reviewer_role?.replace('_', ' ')})
                          </span>
                          <span
                            className={`font-bold px-2 py-0.5 rounded text-[11px] ${
                              r.decision === 'Approved'
                                ? 'bg-teal-100 text-teal-800'
                                : r.decision === 'Needs Revision'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {r.decision}
                          </span>
                        </div>
                        <p className="text-slate-600">{r.comments}</p>
                        <div className="text-[10px] text-slate-400 mt-1 font-mono">
                          {new Date(r.created_at).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white p-12 rounded-xl border border-slate-200 text-center text-xs text-slate-400">
              Select a submission from the queue on the left to review.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
