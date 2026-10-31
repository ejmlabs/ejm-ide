import { siteDefaults } from '@ejm/site/head';
import { defineSite } from '@ejm/ssg';
import Home from './pages/Home';
import NotFound from './pages/NotFound';
import { App } from './shell';
import './styles.css';

export default defineSite({
  ...siteDefaults('ide', {
    description:
      'ejm-ide is a free, open-source desktop editor from ejmlabs. Built in Rust, with precise code navigation and an agent beside your code.',
  }),
  App,
  routes: [{ path: '/', component: Home, head: { title: 'ejm-ide' } }],
  notFound: { component: NotFound, head: { title: 'Page not found' } },
});
