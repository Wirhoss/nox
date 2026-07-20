import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true,
});

markdown.disable(['image']);

const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index]?.attrSet('target', '_blank');
  tokens[index]?.attrSet('rel', 'noreferrer noopener');
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, environment, renderer)
    : renderer.renderToken(tokens, index, options);
};

function renderMarkdown(source: string): string {
  return markdown.render(source);
}

export {
  renderMarkdown,
};
