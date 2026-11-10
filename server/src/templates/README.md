# Email Templates

This directory contains pre-made, modern HTML email templates for use in your mail service campaigns.

## Available Templates

One category: **Cold Outreach Sequence**. Five plain templates meant to be
used in order as the steps of one campaign.

| # | File | Wait | Role |
|---|---|---|---|
| 1 | `outreach-01-opener.html` | — | Problem first, evidence-personalised, ends on a question |
| 2 | `outreach-02-reminder.html` | 3d | Short nudge on the same thread |
| 3 | `outreach-03-their-process.html` | 4d | Asks how they screen today |
| 4 | `outreach-04-use-case.html` | 5d | One concrete scenario |
| 5 | `outreach-05-break-up.html` | 6d | Closes the loop, asks for nothing |

### These are deliberately plain

No images, no buttons, no colour blocks, no header bar. System fonts, one
thin rule above the signature.

That is the design, not an omission. A designed template announces itself as
a campaign before a word is read, which costs both replies and inbox
placement on a cold first contact. All five score 100 on the built-in spam
linter; the seven designed templates this repo used to carry scored 84-92,
the gap being link count and markup weight.

**Before adding a header bar, brand colour or CTA button, read
`SEQUENCE_PLAYBOOK.md` at the repo root.** It explains the eight copy rules
the wording follows and why the plainness matters.

The old designed templates remain in git history if a newsletter is ever
needed:

```bash
git log --diff-filter=D --name-only -- server/src/templates
```

## Using Templates in Campaigns

### Method 1: Copy-Paste HTML
1. Open the template HTML file
2. Copy all the HTML content
3. Paste into the "Body (HTML)" field in your campaign editor
4. The merge fields (`{{first_name}}`, `{{company}}`, etc.) will be automatically replaced

### Method 2: API Integration
Templates can be loaded programmatically via the `templates.js` module:

```javascript
import { loadTemplate, getTemplateList } from './templates.js';

// Get list of all templates
const templates = getTemplateList();

// Load a specific template
const template = loadTemplate('outreach-01-opener');
// Returns: { id, name, description, content, ... }
```

## Merge Fields

All templates support the following merge fields:

- `{{first_name}}` - Recipient's first name
- `{{last_name}}` - Recipient's last name
- `{{company}}` - Recipient's company name
- `{{email}}` - Recipient's email address

These fields are automatically replaced with actual contact data when emails are sent.

## Customizing Templates

### Option 1: Direct HTML Editing
1. Open the template file
2. Edit the HTML directly
3. Update inline styles or content
4. Copy the updated HTML into your campaign

### Option 2: Create a New Template
1. Copy an existing template as a starting point
2. Rename the file (e.g., `my-custom-template.html`)
3. Edit the HTML to match your brand
4. Update `manifest.json` with your new template metadata

### Style Customization Tips
- Change primary color: Update all instances of `#3b82f6` (or the template's primary color) to your brand color
- Adjust fonts: Modify `font-family` in the `<style>` section
- Change spacing: Adjust `padding` and `margin` values
- Update company name: Replace text in footer sections

## Mobile Responsiveness

All templates include responsive design with media queries for mobile devices (screen width < 600px). They will automatically adapt to different email clients and devices.

## Template Metadata

The `manifest.json` file contains metadata about each template:
- Template ID, name, and description
- Associated file path
- Color scheme
- Best use cases
- Feature flags (hasButton, hasStats, etc.)
- Supported merge fields

## Brand Customization

To customize templates for your brand:

1. **Logo**: Replace or update the logo area in the header
2. **Colors**: Search and replace brand colors throughout
3. **Contact Info**: Update footer with your contact information
4. **Links**: Update all `href="#"` links to your actual URLs
5. **Company Name**: Replace "Your Company" throughout

## Testing Templates

Before using a template in a live campaign:

1. Use the campaign preview feature to see how merge fields are replaced
2. Send a test email to yourself
3. Check rendering in different email clients (Gmail, Outlook, Apple Mail, etc.)
4. Verify all links work correctly
5. Test on mobile devices

## Email Client Compatibility

All templates are tested and compatible with:
- Gmail (Web and Mobile)
- Outlook (Desktop and Web)
- Apple Mail
- iOS Mail
- Android Mail
- Yahoo Mail
- AOL Mail

## Adding New Templates

1. Create a new HTML file in this directory
2. Use the template structure from an existing template
3. Ensure all styles are inline or in `<style>` tags
4. Include merge fields: `{{first_name}}`, `{{company}}`, etc.
5. Add responsive design with mobile media query
6. Update `manifest.json` with your new template's metadata

## CSS Best Practices for Email

- Use inline styles where possible (some email clients don't support `<style>` tags)
- Avoid CSS that email clients don't support (animations, transforms, etc.)
- Use web-safe fonts or fallbacks
- Keep layouts simple and linear
- Test background images (some clients block them)
- Use table layouts for complex designs
- Avoid absolute positioning
