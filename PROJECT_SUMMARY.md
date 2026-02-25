# Non-Profit Funder Finder

A complete Vite + React + TypeScript application that helps nonprofits discover funding opportunities aligned with their mission.

## Project Location
`/sessions/kind-happy-wozniak/mnt/outputs/funder-finder/`

## Project Structure

```
funder-finder/
├── .github/
│   └── workflows/
│       └── deploy.yml              # GitHub Pages deployment workflow
├── public/
│   └── 404.html                   # SPA routing fallback for GitHub Pages
├── src/
│   ├── pages/
│   │   ├── Landing.tsx            # Hero page with how-it-works section
│   │   ├── MissionInput.tsx        # Mission statement & keyword input
│   │   ├── Results.tsx             # Search results with ranked matches
│   │   ├── FunderDetail.tsx        # Individual funder detail page
│   │   ├── SavedFunders.tsx        # Saved funders management
│   │   └── NotFound.tsx            # 404 page
│   ├── data/
│   │   └── funders.ts              # 15 curated funder database
│   ├── utils/
│   │   ├── matching.ts             # Smart matching algorithm
│   │   └── storage.ts              # LocalStorage utilities
│   ├── App.tsx                     # Main app component with routing
│   ├── main.tsx                    # React entry point
│   ├── index.css                   # Tailwind + fonts
│   └── types.ts                    # TypeScript interfaces
├── index.html                      # Main HTML with SPA redirect
├── package.json                    # Dependencies configuration
├── tailwind.config.js              # Tailwind CSS configuration
├── postcss.config.js               # PostCSS configuration
├── vite.config.ts                  # Vite configuration
├── tsconfig.json                   # TypeScript configuration
├── tsconfig.node.json              # TypeScript Node configuration
├── .gitignore                      # Git ignore rules
└── PROJECT_SUMMARY.md              # This file
```

## All Files Created

### Configuration Files
1. **package.json** - Dependencies and build scripts
2. **tsconfig.json** - TypeScript compiler options
3. **tsconfig.node.json** - TypeScript Node config
4. **vite.config.ts** - Vite build configuration with GitHub Pages base path
5. **tailwind.config.js** - Tailwind CSS theming (dark theme)
6. **postcss.config.js** - PostCSS plugins for Tailwind

### HTML & Public
7. **index.html** - Main entry point with SPA redirect script
8. **public/404.html** - GitHub Pages 404 redirect for SPA routing

### Source Code
9. **src/main.tsx** - React app entry point
10. **src/App.tsx** - Main app with BrowserRouter and routes
11. **src/index.css** - Global styles with Tailwind directives
12. **src/types.ts** - Funder interface definition

### Data & Utils
13. **src/data/funders.ts** - 15 funders database:
    - Gates Foundation
    - Silicon Valley Community Foundation
    - Ford Foundation
    - Kellogg Foundation
    - Lumina Foundation
    - Hewlett Foundation
    - Annie E. Casey Foundation
    - Walton Family Foundation
    - Schwab Charitable
    - Google.org
    - MacArthur Foundation
    - JPMorgan Chase Foundation
    - Robert Wood Johnson Foundation
    - Weingart Foundation
    - Skoll Foundation

14. **src/utils/matching.ts** - Smart matching algorithm based on:
    - Focus area keyword matches (3 points)
    - User keywords matching (2 points)
    - Common word similarity (0.5 points)

15. **src/utils/storage.ts** - LocalStorage management for saved funders

### Pages
16. **src/pages/Landing.tsx** - Welcome page with:
    - Hero section
    - How it works (3 steps)
    - What's included features
    - Call-to-action button

17. **src/pages/MissionInput.tsx** - Input page with:
    - Mission statement textarea (required)
    - Keywords input with suggestions
    - Example missions quick-fill
    - Character counter

18. **src/pages/Results.tsx** - Results page featuring:
    - Ranked funder matches
    - Mission alignment tags
    - Copy email functionality
    - Save/unsave functionality
    - CSV export
    - View details link per funder

19. **src/pages/FunderDetail.tsx** - Detail page with:
    - Full funder information
    - Focus areas display
    - Recommended next steps
    - Complete contact information
    - Copy email/phone buttons
    - Save/unsave functionality

20. **src/pages/SavedFunders.tsx** - Saved funders management:
    - View all saved funders
    - Remove from saved
    - CSV export
    - View details link

21. **src/pages/NotFound.tsx** - 404 error page

### CI/CD
22. **.github/workflows/deploy.yml** - GitHub Actions workflow for:
    - Building on push to main
    - Deploying to GitHub Pages
    - Manual workflow_dispatch trigger

### Additional
23. **.gitignore** - Standard Node/Vite ignore rules

## Features Implemented

### Core Functionality
- Mission statement input with character counter
- Keyword-based refinement
- Smart matching algorithm
- Ranked results by relevance
- Save/unsave funders to localStorage
- Export to CSV (both results and saved)

### User Interface
- Dark theme with GitHub-like colors (#0d1117, #161b22, #30363d)
- Responsive design (mobile-first)
- Lucide React icons throughout
- Smooth transitions and hover effects
- Clean, modern card-based layouts
- Proper loading states

### Routing
- 6 main routes:
  - `/` - Landing page
  - `/mission` - Mission input
  - `/results` - Search results
  - `/funder/:id` - Funder detail
  - `/saved` - Saved funders
  - `*` - 404 page

### Data
- 15 curated funders with:
  - Contact names and titles
  - Email and phone
  - Website URLs
  - Focus areas (8-10 per funder)
  - Grant ranges
  - Recommended next steps
  - Organization descriptions

## Tech Stack

**Frontend Framework:**
- React 18.3.1
- React Router DOM 6.24.0

**Build Tools:**
- Vite 5.0.8
- TypeScript 5.2.2

**Styling:**
- Tailwind CSS 3.3.6
- PostCSS 8.4.32
- Autoprefixer 10.4.16

**Icons:**
- Lucide React 0.294.0

## Installation & Setup

To install and build locally:

```bash
cd /sessions/kind-happy-wozniak/mnt/outputs/funder-finder

# Install dependencies
npm install

# Development server
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

## GitHub Pages Deployment

1. Push to GitHub main branch
2. GitHub Actions workflow automatically:
   - Installs dependencies
   - Builds the project
   - Deploys to GitHub Pages at `username.github.io/funder-finder/`

## Browser Support

Works in all modern browsers (Chrome, Firefox, Safari, Edge).

## Future Enhancements

- Search/filter functionality
- Advanced filtering by funder type, location, grant range
- Funding opportunity tracking
- Email templates
- Integration with actual funder APIs
- User accounts and preferences
- Advanced analytics

## Notes

- All contact information is for demonstration purposes
- The app stores saved funders in browser localStorage
- Mission matching is basic keyword/focus area matching
- Ready for integration with real funder APIs or databases
