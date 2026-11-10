export default function CampaignHeader({ editing, onCancel, onSave, busy, disableSave }) {
  return (
    <div className="campaign-header">
      <div className="header-breadcrumb">
        <span className="breadcrumb-link">Campaigns</span>
        <span className="breadcrumb-sep">/</span>
        <span className="breadcrumb-current">
          {editing ? 'Edit Campaign' : 'New Campaign'}
        </span>
      </div>

      <div className="header-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onSave} disabled={busy || disableSave}>
          {busy ? 'Saving...' : editing ? 'Update' : 'Create Campaign'}
        </button>
      </div>
    </div>
  );
}
