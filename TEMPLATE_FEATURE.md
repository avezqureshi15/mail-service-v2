# Template Selector & Live Preview Feature

## Overview

Sales people can now **select email templates**, **edit content in a simple form**, and see a **live preview** of how the email will look when sent. **No HTML knowledge required!**

## ✨ Features

### 1. **Template Selector**
- Browse the pre-made templates
- Filter by category
- The repo currently ships one category, Cold Outreach Sequence - five plain
  templates meant to be used in order. See SEQUENCE_PLAYBOOK.md for why they
  carry no images, buttons or colour blocks.
- Visual cards showing template name, description, best-use cases, and color scheme
- Click to select - updates automatically

### 2. **Simple Content Editor**
- **Subject Line**: Easy text input with merge field placeholders
- **Two Edit Modes**:
  - **Simple Edit**: Edit text sections with minimal HTML knowledge
  - **HTML Edit**: Raw HTML for advanced users
- Shows current template being used
- Merge fields auto-populated: `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{email}}`

### 3. **Live Preview Panel**
- Real-time preview shows exactly how email looks
- Automatically replaces merge fields with sample data
- Responsive design shows desktop view
- Shows subject line with merge fields replaced
- Updates instantly as you type

## 📁 New Files Created

### Frontend Components
```
web/src/components/
├── TemplateSelector.jsx     # Template selection UI with categories
├── TemplateEditor.jsx       # Content editor with simple/HTML modes
└── TemplatePreview.jsx      # Live preview panel with iframe
```

### Server Files
```
server/src/templates/
├── manifest.json            # Template registry & metadata
├── templates.js             # Node.js module for loading templates
├── README.md                # Documentation
├── outreach-01-opener.html        # Sequence step 1
├── outreach-02-reminder.html      # Sequence step 2
├── outreach-03-their-process.html # Sequence step 3
├── outreach-04-use-case.html      # Sequence step 4
└── outreach-05-break-up.html      # Sequence step 5

server/src/routes/
└── templates.js             # API endpoints for templates
```

### Modified Files
```
server/src/index.js          # Added templates router to API
web/src/pages/CampaignEditor.jsx  # Integrated template components
web/src/styles.css           # Added template component styles
```

## 🎯 How Sales People Use It

### Step 1: Create Campaign
1. Go to "New Campaign"
2. Fill in Campaign Name, Select List, From Name, etc.

### Step 2: Select Template
- Scroll to "Email Template" section
- See all 4 templates with descriptions
- Click on a template to select it
- Template info appears with category and use cases

### Step 3: Edit Content
- **Subject Line**: Type subject with optional merge fields
- **Message Body**: Edit text sections or raw HTML
- Toggle between "Simple Edit" and "HTML Edit" as needed

### Step 4: See Live Preview
- Right panel shows "Live Preview" updating in real-time
- Shows subject with merge fields replaced
- Email rendered exactly as recipients will see it
- Sample data: John Smith from Acme Corp

### Step 5: Save Campaign
- Click "Save" when happy with preview
- Campaign ready to send!

## 🔧 API Endpoints

All endpoints are authenticated (require login):

```
GET  /api/templates/                    # List all templates
GET  /api/templates/:templateId          # Get specific template with HTML
GET  /api/templates/categories           # Get all categories
GET  /api/templates/merge-fields         # Get merge field guide
GET  /api/templates/by-category/:id     # Get templates by category
```

### Example Response
```json
{
  "template": {
    "id": "outreach-01-opener",
    "name": "Modern Minimal",
    "description": "Clean, minimalist design...",
    "category": "outreach",
    "colors": ["#3b82f6", "#ffffff"],
    "bestFor": ["First touch outreach", "Quick engagement emails"],
    "features": {
      "hasHeader": true,
      "hasFooter": true,
      "hasButton": true,
      "responsive": true
    },
    "content": "<html>...full email HTML...</html>",
    "mergeFields": ["{{first_name}}", "{{company}}", ...]
  }
}
```

## 📧 Available Templates

### 1. Modern Minimal
- **Best for**: Quick outreach, first touches
- **Style**: Clean, tech-focused, minimalist
- **Colors**: Blue accent
- **Features**: Simple header, call-to-action button

### 2. Professional Business
- **Best for**: Enterprise proposals, demos, partnerships
- **Style**: Polished gradient design
- **Colors**: Purple gradient, professional
- **Features**: Header, feature highlights, call-to-action

### 3. Newsletter Modern
- **Best for**: Updates, announcements, content distribution
- **Style**: Multi-section layout with article cards
- **Colors**: Blue and white
- **Features**: Multiple sections, statistics display, article cards

### 4. Corporate Elegant
- **Best for**: Executive outreach, formal proposals
- **Style**: Premium, serif typography, gold accents
- **Colors**: Black, gold, white
- **Features**: Sophisticated design, benefits section

## 🎨 Customizing Templates

### Edit Existing Template
1. Open template file: `server/src/templates/[template-name].html`
2. Modify HTML/CSS as needed
3. Keep merge fields: `{{first_name}}`, `{{company}}`, etc.
4. Save and restart server

### Create New Template
1. Copy existing template as starting point
2. Name file: `server/src/templates/my-template.html`
3. Update `server/src/templates/manifest.json`:
   ```json
   {
     "id": "my-template",
     "name": "My Template",
     "description": "...",
     "file": "my-template.html",
     "category": "outreach",
     "colors": ["#fff", "#000"],
     "bestFor": ["..."],
     "features": { ... }
   }
   ```
4. Restart server

### Brand Customization
All templates have:
- **Easy color swapping**: Find and replace hex colors
- **Responsive design**: Works on all devices and email clients
- **Merge field support**: `{{first_name}}`, `{{company}}`, etc.
- **Link placeholders**: Replace `href="#"` with real URLs

## 🔄 Workflow Example

**Before (Old Way):**
- Copy HTML from template file
- Paste into campaign body textarea
- Fix broken formatting
- Search/replace merge fields manually
- Send test email, see rendering issues

**After (New Way):**
- Click "Modern Minimal" template
- Type subject: "Question about {{company}}"
- Type message in simple editor
- See live preview on right
- Click Save

## 📱 Responsive Design

All templates automatically adapt to:
- Desktop emails
- Mobile screens
- Tablet views
- All major email clients (Gmail, Outlook, Apple Mail, etc.)

Live preview shows desktop rendering by default.

## 🔐 Merge Field Substitution

When email is sent, merge fields are replaced with contact data:

| Merge Field | Replaced With |
|-------------|---------------|
| `{{first_name}}` | Contact's first name |
| `{{last_name}}` | Contact's last name |
| `{{company}}` | Contact's company |
| `{{email}}` | Contact's email address |
| Any CSV column | Value from contact data |

**Example:**
- Template: `Hi {{first_name}}, I noticed {{company}}...`
- Recipient: John Smith at Acme Corp
- Sent as: `Hi John, I noticed Acme Corp...`

## ⚙️ Technical Details

### Frontend
- React components with hooks
- Real-time preview via `iframe`
- Two-mode editor (simple/HTML)
- API integration for template loading
- Live merge field replacement in preview

### Server
- Template module with caching
- REST API for template discovery
- Manifest-based template registry
- Support for new template additions without code changes

### Database
- No database changes needed
- Templates stored as HTML files
- Metadata in JSON manifest
- Zero template state tracking (stateless)

## 🚀 Getting Started

### Prerequisites
- Mail service running locally or deployed
- Web app already built: `npm run build`

### Installation
1. All files already created in this codebase
2. Restart server: `npm run dev` (or your start command)
3. Navigate to "New Campaign" in web app
4. See template selector below campaign setup

### First Campaign
1. Name: "My First Campaign"
2. Select list: "Test Contacts"
3. Select template: "Modern Minimal"
4. Edit subject and message in preview
5. Save campaign
6. Test send to yourself
7. View in email client

## 📊 Stats

- **4 professional templates** ready to use
- **100% responsive** across devices
- **2 edit modes** for flexibility
- **Live preview** updates in real-time
- **0% HTML required** for basic usage
- **Merge field support** for personalization

## 🐛 Troubleshooting

### Templates not showing?
- Make sure server restarted after adding files
- Check `/api/templates` endpoint
- Verify `manifest.json` is valid JSON

### Preview blank?
- Make sure template is selected
- Check browser console for errors
- Verify HTML body has content

### Merge fields not replacing in preview?
- Use exact format: `{{field_name}}`
- Check field names in manifest
- Preview uses sample data (John Smith, Acme Corp)

## 📝 Future Enhancements

Potential features to add:
- Custom template uploads
- Template versioning/rollback
- A/B testing different templates
- Performance analytics per template
- Template category management UI
- Drag-and-drop template builder
- Save as template from existing campaign
