import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api.js';
import { StatusBadge } from './Dashboard.jsx';

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState('');
  const [subCategories, setSubCategories] = useState([]);
  const [subCategoryId, setSubCategoryId] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (categoryId) params.set('categoryId', categoryId);
      if (subCategoryId) params.set('subCategoryId', subCategoryId);

      const [campaignData, categoryData] = await Promise.all([
        api.get(`/campaigns?${params.toString()}`),
        api.get('/campaigns/categories'),
      ]);
      setCampaigns(campaignData.rows);
      setCategories(categoryData.categories ?? []);
    } catch (err) {
      setError(err.message);
    }
  }

  // Switching category invalidates the selected sub-category, since the old
  // one belongs to a different parent.
  async function changeCategory(nextCategoryId) {
    setCategoryId(nextCategoryId);
    setSubCategoryId('');
    setSubCategories([]);
    setError('');
    if (!nextCategoryId) return;
    try {
      const data = await api.get(`/campaigns/subcategories/${nextCategoryId}`);
      setSubCategories(data.subCategories ?? []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
    // Reload when either filter changes so the interval always uses it too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, subCategoryId]);

  const totalAcrossCategories = categories.reduce((sum, c) => sum + c.count, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Campaigns</h2>
          <p>Every send is paced automatically and carries a working unsubscribe.</p>
        </div>
        <Link className="btn" to="/campaigns/new">New campaign</Link>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="filter-bar">
        <div className="filter-field">
          <label htmlFor="filter-category">Category</label>
          <select
            id="filter-category"
            value={categoryId}
            onChange={(e) => changeCategory(e.target.value)}
          >
            <option value="">All categories ({totalAcrossCategories})</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name} ({category.count})
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="filter-subcategory">Sub-category</label>
          <select
            id="filter-subcategory"
            value={subCategoryId}
            onChange={(e) => setSubCategoryId(e.target.value)}
            disabled={!categoryId || subCategories.length === 0}
          >
            <option value="">
              {!categoryId
                ? 'Select a category first'
                : subCategories.length === 0 ? 'No sub-categories' : 'All sub-categories'}
            </option>
            {subCategories.map((subCategory) => (
              <option key={subCategory.id} value={subCategory.id}>
                {subCategory.name} ({subCategory.count})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        {campaigns.length === 0 ? (
          <div className="empty">
            No campaigns {categoryId ? 'match these filters' : 'yet'}.
            {' '}<Link to="/campaigns/new">Create one</Link>.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Sub-category</th>
                  <th>Status</th>
                  <th>List</th>
                  <th>Type</th>
                  <th className="num">Progress</th>
                  <th>Created by</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td>
                      {c.category_name
                        ? <span className="badge neutral">{c.category_name}</span>
                        : <span className="muted">Uncategorised</span>}
                    </td>
                    <td>
                      {c.sub_category_name
                        ? <span className="badge neutral">{c.sub_category_name}</span>
                        : <span className="muted">--</span>}
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>{c.list_name ?? <span className="muted">--</span>}</td>
                    <td>
                      {c.is_sequence
                        ? <span className="badge neutral">sequence</span>
                        : <span className="muted">single</span>}
                      {Boolean(c.tracking_enabled) && (
                        <span className="badge warn" style={{ marginLeft: 5 }}>tracked</span>
                      )}
                    </td>
                    <td className="num nowrap">{c.sent_count} / {c.total_jobs}</td>
                    <td className="muted">{c.created_by_name || c.created_by_email || '--'}</td>
                    <td className="muted nowrap">{formatDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
