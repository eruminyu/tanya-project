import { createApp } from 'vue';
import App from './App.vue';
import '../../desktop/src/renderer/style.css';
import './web.css';
import { profile } from './profile';

document.title = profile.pageTitle;

createApp(App).mount('#app');
