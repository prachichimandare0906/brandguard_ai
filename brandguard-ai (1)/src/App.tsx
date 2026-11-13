/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SignInScreen } from './components/auth/SignInScreen';
import { Sidebar, NavItem } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { OverviewTab } from './components/overview/OverviewTab';
import { BrandKnowledgeHub } from './components/hub/BrandKnowledgeHub';
import { ContentReviewTab } from './components/review/ContentReviewTab';
import { ComplianceReportsTab } from './components/reports/ComplianceReportsTab';
import { ApprovalCentreTab } from './components/approval/ApprovalCentreTab';
import { GovernanceAnalyticsTab } from './components/analytics/GovernanceAnalyticsTab';
import { SettingsTab } from './components/settings/SettingsTab';
import {
  Guideline,
  ApprovedFact,
  TerminologyItem,
  BrandAsset,
  Submission,
  AnalyticsData,
  UserRole,
} from './types';
import { api } from './services/api';
import { AlertCircle, ShieldCheck, X } from 'lucide-react';

function BrandGuardWorkspace() {
  const { user, activeOrg, memberships, loading, logout, switchOrg, createOrg } = useAuth();
  const [currentTab, setCurrentTab] = useState<NavItem>('overview');

  // Organisation-scoped data state
  const [guidelines, setGuidelines] = useState<Guideline[]>([]);
  const [facts, setFacts] = useState<ApprovedFact[]>([]);
  const [terminology, setTerminology] = useState<TerminologyItem[]>([]);
  const [assets, setAssets] = useState<BrandAsset[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);

  const [reviewSubmissionId, setReviewSubmissionId] = useState<string | undefined>(undefined);
  const [isResetting, setIsResetting] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const loadAllData = useCallback(async () => {
    if (loading || !user || !activeOrg) return;
    setDataError(null);
    try {
      const [guidelinesData, factsData, termsData, assetsData, subsData, analyticsData] =
        await Promise.all([
          api.getGuidelines(),
          api.getFacts(),
          api.getTerminology(),
          api.getAssets(),
          api.getSubmissions(),
          api.getAnalytics(),
        ]);

      setGuidelines(guidelinesData);
      setFacts(factsData);
      setTerminology(termsData);
      setAssets(assetsData);
      setSubmissions(subsData);
      setAnalytics(analyticsData);
    } catch (err: any) {
      setDataError(err?.message || 'Failed to load workspace governance data.');
    }
  }, [loading, user, activeOrg]);

  useEffect(() => {
    if (loading) return;
    if (user && activeOrg) {
      loadAllData();
    } else {
      setGuidelines([]);
      setFacts([]);
      setTerminology([]);
      setAssets([]);
      setSubmissions([]);
      setAnalytics(null);
    }
  }, [loading, user?.id, activeOrg?.orgId, loadAllData]);

  const confirmResetDemo = async () => {
    setIsResetting(true);
    setDataError(null);
    try {
      await api.resetDemo();
      setShowResetModal(false);
      await loadAllData();
    } catch (err: any) {
      setDataError(err?.message || 'Workspace reset failed.');
    } finally {
      setIsResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-slate-600">
          <div className="w-10 h-10 rounded-lg bg-slate-900 flex items-center justify-center text-teal-400">
            <ShieldCheck className="w-6 h-6 animate-pulse" />
          </div>
          <span className="text-xs font-medium">Verifying authenticated session...</span>
        </div>
      </div>
    );
  }

  if (!user || !activeOrg) {
    return <SignInScreen />;
  }

  const userRole: UserRole = activeOrg.role || user.role;

  const tabTitles: Record<NavItem, string> = {
    overview: 'Overview',
    hub: 'Brand Knowledge Hub',
    review: 'Content Review',
    reports: 'Compliance Reports',
    approval: 'Approval Centre',
    analytics: 'Governance Analytics',
    settings: 'Settings & RBAC',
  };

  const pendingCount = submissions.filter((s) => s.status === 'In Review').length;

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 font-sans antialiased">
      {/* 1. Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={(tab) => {
          setReviewSubmissionId(undefined);
          setCurrentTab(tab);
        }}
        pendingCount={pendingCount}
        activeOrg={activeOrg}
        memberships={memberships}
        onSwitchOrg={async (orgId) => {
          setReviewSubmissionId(undefined);
          await switchOrg(orgId);
        }}
      />

      {/* 2. Main Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <Header
          currentTabName={tabTitles[currentTab]}
          currentUser={{ ...user, role: userRole }}
          activeOrg={activeOrg}
          onLogout={logout}
          onRequestResetDemo={() => setShowResetModal(true)}
          isResetting={isResetting}
        />

        {/* Content Viewport */}
        <main className="flex-1 p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {dataError && (
            <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{dataError}</span>
              </div>
              <button onClick={() => setDataError(null)} className="text-rose-500 hover:text-rose-700">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {currentTab === 'overview' && (
            <OverviewTab
              analytics={analytics}
              submissions={submissions}
              orgName={activeOrg.name}
              onNavigate={(tab, subId) => {
                setReviewSubmissionId(subId);
                setCurrentTab(tab);
              }}
              onQuickTestDemo={() => {
                setReviewSubmissionId(undefined);
                setCurrentTab('review');
              }}
            />
          )}

          {currentTab === 'hub' && (
            <BrandKnowledgeHub
              guidelines={guidelines}
              facts={facts}
              terminology={terminology}
              assets={assets}
              orgName={activeOrg.name}
              userRole={userRole}
              onRefresh={loadAllData}
            />
          )}

          {currentTab === 'review' && (
            <ContentReviewTab
              initialSubmissionId={reviewSubmissionId}
              currentUserId={user.id}
              userRole={userRole}
              orgName={activeOrg.name}
              onSubmissionUpdated={loadAllData}
              onNavigateToApproval={(subId) => {
                setReviewSubmissionId(subId);
                setCurrentTab('approval');
              }}
              onNavigateToReport={(subId) => {
                setReviewSubmissionId(subId);
                setCurrentTab('reports');
              }}
            />
          )}

          {currentTab === 'reports' && (
            <ComplianceReportsTab
              submissions={submissions}
              initialSubmissionId={reviewSubmissionId}
              orgName={activeOrg.name}
            />
          )}

          {currentTab === 'approval' && (
            <ApprovalCentreTab
              submissions={submissions}
              initialSubmissionId={reviewSubmissionId}
              currentUser={{ ...user, role: userRole }}
              orgName={activeOrg.name}
              onRefresh={loadAllData}
              onSelectSubmissionForReview={(subId) => {
                setReviewSubmissionId(subId);
                setCurrentTab('review');
              }}
            />
          )}

          {currentTab === 'analytics' && (
            <GovernanceAnalyticsTab
              analytics={analytics}
              orgName={activeOrg.name}
              onRefresh={loadAllData}
            />
          )}

          {currentTab === 'settings' && (
            <SettingsTab
              currentUser={{ ...user, role: userRole }}
              activeOrg={activeOrg}
              memberships={memberships}
              onCreateOrg={createOrg}
              onSwitchOrg={async (orgId) => {
                setReviewSubmissionId(undefined);
                await switchOrg(orgId);
              }}
              onRequestResetDemo={() => setShowResetModal(true)}
              isResetting={isResetting}
            />
          )}
        </main>
      </div>

      {/* In-app Starter Workspace Reset Confirmation Modal */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-900">Reset Starter Workspace Data?</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              This will restore <strong>{activeOrg.name}</strong>'s guidelines, approved facts, terminology, assets, and
              starter submissions to the baseline governance set. Team members, audit logs, and other organisations remain untouched.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowResetModal(false)}
                disabled={isResetting}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={confirmResetDemo}
                disabled={isResetting}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg disabled:opacity-50"
              >
                {isResetting ? 'Resetting...' : 'Confirm Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrandGuardWorkspace />
    </AuthProvider>
  );
}
