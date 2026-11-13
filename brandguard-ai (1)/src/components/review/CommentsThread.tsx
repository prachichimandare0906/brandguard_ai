import React, { useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { SubmissionComment } from '../../types';
import { api } from '../../services/api';

interface CommentsThreadProps {
  submissionId: string;
  comments: SubmissionComment[];
  onCommentAdded: (comment: SubmissionComment) => void;
}

export const CommentsThread: React.FC<CommentsThreadProps> = ({
  submissionId,
  comments,
  onCommentAdded,
}) => {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = body.trim();
    if (!clean) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.addComment(submissionId, clean);
      onCommentAdded(res.comment);
      setBody('');
    } catch (err: any) {
      setError(err.message || 'Failed to post comment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
          <MessageSquare className="w-4 h-4 text-teal-600" />
          <span>Reviewer & Creator Discussion ({comments.length})</span>
        </h4>
      </div>

      {comments.length === 0 ? (
        <p className="text-xs text-slate-400 py-2">No discussion comments yet. Add a note for reviewers or creators below.</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {comments.map((c) => (
            <div key={c.id} className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900">{c.author_name}</span>
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                    {c.author_role.replace('_', ' ')}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-slate-400">
                  {new Date(c.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-slate-700 leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
      )}

      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}

      <form onSubmit={handleSubmit} className="flex items-center gap-2 pt-1">
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a review question, clarification, or compliance note..."
          className="flex-1 text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        <button
          type="submit"
          disabled={submitting || !body.trim()}
          className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Post</span>
        </button>
      </form>
    </div>
  );
};
