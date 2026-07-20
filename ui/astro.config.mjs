import svelte from '@astrojs/svelte';
// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	integrations: [svelte()],
	vite: {
		server: {
			proxy: {
				'/api': 'http://localhost:3000',
			},
		},
	},
});
