import { siteDefaults } from '@ejm/site/head';
import { defineSite } from '@ejm/ssg';
import NotFound from './pages/NotFound';
import { App } from './shell';
import './styles.css';

// The Worker owns /downloads/ (installer files), so the download page is /download/.
export default defineSite({
  ...siteDefaults('ide', {
    description:
      'An MIT-licensed open-source desktop editor with language tools, Git and the Edi agent. Build from source, read the docs or contribute.',
  }),
  // Keep the existing measured exception for shared docs and the native-shaped local example.
  // Measure the route and visible player together; browser transfer also counts response headers.
  // Fonts and HTML retain their default budgets.
  budget: { js: 110, css: 15.5 },
  App,
  routes: [
    {
      path: '/',
      load: () => import('./pages/Home'),
      head: { title: 'An open-source desktop editor' },
    },
    {
      path: '/download/',
      load: () => import('./pages/Download'),
      head: {
        title: 'Download',
        description:
          'Installers for ejm-ide by platform. A platform is listed only after its installer is built, signed and verified.',
      },
    },
    {
      path: '/docs/',
      load: () => import('./pages/DocsIndex'),
      head: {
        title: 'Documentation',
        description:
          'Learn to use ejm-ide and Edi, set up a source build, or contribute to the desktop editor.',
      },
    },
    {
      path: '/docs/user-guide/',
      load: () => import('./pages/UserGuide'),
      head: {
        title: 'User guide',
        description:
          'Set up ejm-ide, open a project, connect a model, and use the editor, Edi, Git, and language tools.',
      },
    },
    {
      path: '/docs/developer-guide/',
      load: () => import('./pages/DeveloperGuide'),
      head: {
        title: 'Developer guide',
        description:
          'Build and contribute to ejm-ide: code layout, checks, agent tools, extensions and the public website.',
      },
    },
  ],
  notFound: { component: NotFound, head: { title: 'Page not found' } },
});
