import { Routes, Route, Navigate } from 'react-router-dom';
import { TopNav } from './components/TopNav';
import { ServiceHealthBanner } from './components/ServiceHealthBanner';
import { DashboardPage } from './pages/DashboardPage';
import { IssueDetailPage } from './pages/IssueDetailPage';
import { PageScanDetailPage } from './pages/PageScanDetailPage';
import { ComponentDetailPage } from './pages/ComponentDetailPage';
import { ScansListPage } from './pages/ScansListPage';
import { ComponentsListPage } from './pages/ComponentsListPage';
import { RepositoriesListPage } from './pages/RepositoriesListPage';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage';
import { RepositoryIssueDetailPage } from './pages/RepositoryIssueDetailPage';

export default function App() {
  return (
    <div className="app-shell">
      <TopNav />
      <ServiceHealthBanner />
      <main className="page-container">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/scans" element={<ScansListPage />} />
          <Route path="/scans/:scanId" element={<DashboardPage />} />
          <Route path="/scans/:scanId/pages/:pageScanId" element={<PageScanDetailPage />} />
          <Route path="/issues/:issueId" element={<IssueDetailPage />} />
          <Route path="/components" element={<ComponentsListPage />} />
          <Route path="/components/:jobId" element={<ComponentDetailPage />} />
          <Route path="/repositories" element={<RepositoriesListPage />} />
          <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
          <Route path="/repositories/:id/issues/:issueId" element={<RepositoryIssueDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
