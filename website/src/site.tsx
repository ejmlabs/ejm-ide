import { siteDefaults } from '@ejm/site/head';
import { defineSite } from '@ejm/ssg';
import NotFound from './pages/NotFound';
import { App } from './shell';
import './styles.css';

export default defineSite({
  ...siteDefaults('ide', {
    description:
      'ejm-ide is a free, open-source desktop editor from ejmlabs. Built in Rust, with precise code navigation and an agent beside your code.',
  }),
  App,
  routes: [
    {
      path: '/',
      load: () => import('./pages/Home'),
      head: { title: 'Free open-source desktop editor' },
    },
  ],
  notFound: { component: NotFound, head: { title: 'Page not found' } },
});
