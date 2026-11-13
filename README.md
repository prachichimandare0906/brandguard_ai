# BrandGuard AI
### AI-Powered Enterprise Brand Governance & Compliance Platform

<p align="center">
  **Consistency. Compliance. Confidence.**
</p>

**Team:** THE EXCEPTION  
**Team Leader:** Prachi Chimandare  
**Institution:** MIT World Peace University, Pune  
**Event:** CodeNexus – Round 3

---

## 1. Project Overview

BrandGuard AI is an AI-powered brand governance platform designed to help organisations maintain consistent brand communication across their teams and digital channels.

It allows users to submit content for validation against approved brand guidelines, terminology, messaging and reference information.

The platform identifies potential brand violations, explains detected issues and provides correction suggestions while preserving the original intent of the content.

BrandGuard AI supports human review and approval, ensuring that final publishing decisions remain under human control.

## 2. Problem Statement

Organisations often face difficulties maintaining consistent brand identity across different departments, teams and communication channels.

Manual content review can be time-consuming and may overlook:

- Inconsistent brand terminology.
- Incorrect messaging and tone.
- Unsupported promotional claims.
- Inaccurate brand information.
- Incorrect logo and visual usage.
- Accessibility issues.

BrandGuard AI aims to simplify brand validation through intelligent content analysis, centralised governance and structured review workflows.

## 3. Key Features

Only features that are implemented and verified in the final release should be marked as complete.

### Core Brand Governance

- Content submission and validation.
- Brand guideline management.
- Brand terminology and messaging checks.
- Tone and consistency analysis.
- Detection of potential unsupported claims.
- Explanation of detected issues.
- Suggested content corrections.
- Human review and approval.

### AI-Powered Validation

- Gemini-powered content analysis.
- Context-aware brand validation.
- Reference-based guideline checking where implemented.
- AI-generated correction suggestions.
- Rule-based fallback handling where implemented.

### Multi-Tenant Workspace and Security

- User registration and login.
- Secure password hashing using scrypt.
- HttpOnly database-backed sessions.
- Creator, Brand Manager and Administrator roles.
- Organisation-level workspace separation.
- Protected backend routes.
- Audit logging where implemented.

### Visual Governance and Accessibility

List the visual checks that are actually implemented and tested:

- Logo usage validation.
- Brand colour checking.
- Typography consistency.
- Image validation.
- Accessibility checks.
- Alternative text suggestions.

### Collaboration and Review

List the completed collaboration features:

- Content review workflow.
- Approval and rejection.
- Version history.
- Activity tracking.
- Team collaboration.

## 4. Round 3 Improvements

Round 3 focuses on delivering the three improvements committed to during Round 2.

### 4.1 Evidence-Grounded AI and Retrieval-Augmented Generation (RAG)

**Objective:** Make AI validation more reliable by grounding its output in approved brand information.

Planned implementation components:

- Retrieval of relevant brand guideline passages.
- Context-aware content validation.
- Supporting guideline references.
- Evidence-based issue explanations.
- Confidence information where supported.
- Context-aware correction suggestions.

**Implementation status:** Update with the actual completed functionality and testing evidence.

### 4.2 Visual Brand Governance and Accessibility

**Objective:** Extend brand validation beyond text to visual content and accessibility.

Implementation areas:

- Logo compliance.
- Brand colour validation.
- Typography checks.
- Visual asset analysis.
- Accessibility issue detection.
- Alternative text suggestions.

**Implementation status:** Update with the actual completed functionality and testing evidence.

### 4.3 Collaboration, Security and Production Readiness

**Objective:** Make BrandGuard AI suitable for independent use by multiple teams.

Implementation areas:

- Secure authentication.
- Password hashing.
- HttpOnly session cookies.
- Role-based permissions.
- Organisation-level access isolation.
- Audit logging.
- Persistent database storage.
- Secure file storage.
- Version management.

**Implementation status:** Update with the actual completed functionality and testing evidence.

## 5. Technology Stack

Update the technologies below to match the final package files and deployed implementation.

| Layer | Technology |
|---|---|
| Frontend | React 19 |
| Programming Language | TypeScript |
| Styling | Tailwind CSS |
| Backend | Node.js |
| API Framework | Express.js |
| AI Integration | Google Gemini API |
| Password Security | scrypt |
| Authentication | HttpOnly database-backed sessions |
| Document Processing | PDF and DOCX processing |
| Visualisation | Recharts |
| Database | Actual configured database |
| Deployment | Actual configured hosting providers |

## 6. System Architecture

BrandGuard AI uses a frontend and backend architecture.

### Application workflow

1. User opens the BrandGuard AI application.
2. User signs in or creates an organisation workspace.
3. The backend authenticates the user and verifies permissions.
4. User submits content for brand validation.
5. The backend processes the submitted content.
6. The validation engine checks content against available brand rules and reference information.
7. The AI service analyses content where configured.
8. The application generates detected issues and correction suggestions.
9. The user reviews the results.
10. The user makes the final approval or rejection decision.
11. Supported activity and review information is stored.

### Architecture components

- **Frontend:** User interface, workspace and review experience.
- **Backend:** API endpoints, business logic and access control.
- **Authentication:** Password verification and session management.
- **Validation Engine:** Brand rules and content analysis.
- **AI Service:** Gemini-powered analysis where configured.
- **Database:** User, organisation and application data.
- **Storage:** Uploaded files and supporting assets where configured.

See `docs/architecture.md` for implementation details.

## 7. Installation and Local Setup

### Prerequisites

- Node.js compatible with the project.
- npm.
- Git.
- Required database service.
- Gemini API key if AI functionality requires it.

### Clone the repository

```bash
git clone https://github.com/prachichimandare0906/BrandGuard-AI.git
cd BrandGuard-AI
```

### Install dependencies

```bash
npm install
```

If the frontend and backend use separate package files, install dependencies in both directories using their respective package files.

### Environment configuration

Create a `.env` file using `.env.example`.

Configure the required environment variables:

- Gemini API key.
- Database connection string.
- Session secret.
- Frontend origin.
- Backend URL.
- Object storage credentials, if configured.

Never commit the actual `.env` file or credentials to GitHub.

### Start the application

Use the actual scripts defined in the final `package.json`.

For example:

```bash
npm run dev
```

If frontend and backend start independently, document both commands here.

## 8. Environment Variables

The `.env.example` file should document all required variables.

Example names only:

```env
NODE_ENV=development
PORT=3000
GEMINI_API_KEY=your_gemini_api_key
DATABASE_URL=your_database_connection_string
SESSION_SECRET=replace_with_a_long_random_secret
FRONTEND_URL=http://localhost:5173
```

Add storage-specific variables only if the final implementation requires them.

Never put real passwords, API keys, tokens or production secrets in this file.

## 9. Testing and Reliability

The final application should be tested through complete user journeys.

### Authentication

- Workspace registration.
- Valid login.
- Invalid login.
- Session persistence.
- Page refresh after login.
- Logout.
- Protected route access.
- Role-based access.

### Content Validation

- Valid content submission.
- Empty content submission.
- Unsupported file upload.
- Large input handling.
- AI service failure.
- Repeated submissions.
- Validation result display.

### Multi-Tenant Security

- Access restrictions between organisations.
- Role permission enforcement.
- Protected API verification.
- Session expiration.
- Audit log verification.

### User Experience

- Empty states.
- Loading states.
- Error handling.
- Page refresh.
- Navigation.
- Repeated actions.

**Test results:** See `docs/testing.md` for actual execution results. Do not mark a test as passed unless it has been executed successfully.

## 10. Security and Privacy

Security controls implemented in BrandGuard AI should be documented accurately.

These include, where verified:

- scrypt password hashing.
- HttpOnly session cookies.
- Secure cookie configuration.
- Role-based access control.
- Organisation-level data isolation.
- Backend request validation.
- Environment-based secret management.
- Audit logging.

Do not expose API keys, credentials, passwords or session identifiers.

## 11. Deployment

**Live Application:**  
[INSERT VERIFIED PUBLIC APPLICATION URL]

**GitHub Repository:**  
https://github.com/prachichimandare0906/BrandGuard-AI

Document the actual frontend hosting provider, backend hosting provider, database provider and required production environment variables.

The live application must be accessible independently without requiring a local development server.

## 12. Known Limitations

Document any incomplete functionality honestly.

Examples of areas to disclose if applicable:

- RAG retrieval not fully configured.
- Visual validation not yet supported for every asset format.
- Database migration or production storage integration pending.
- Limited automated test coverage.
- Dependence on external AI service availability.

Do not list a limitation if it has been resolved and verified.

## 13. Future Roadmap

### Short-Term

- Improve evidence retrieval accuracy.
- Expand brand guideline formats.
- Improve validation explanations.
- Increase automated test coverage.

### Medium-Term

- Advanced visual brand analysis.
- More comprehensive accessibility checks.
- Expanded team review and approval workflows.
- Compliance analytics and reporting.

### Long-Term

- Enterprise integrations.
- Advanced brand compliance dashboards.
- Scalable multi-organisation deployment.
- Additional AI-assisted governance capabilities.

## 14. Project Team

**Team Name:** THE EXCEPTION

**Team Leader:** Prachi Chimandare  
**Institution:** MIT World Peace University, Pune

---

## 15. Conclusion

BrandGuard AI aims to make brand governance more intelligent, consistent and accessible.

By combining AI-assisted validation, brand guidelines, structured review and organisation-level security, the platform helps teams maintain confidence in every brand communication.

**BrandGuard AI – Consistency, Compliance and Confidence in Every Brand Communication.**
