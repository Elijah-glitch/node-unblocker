"use strict";
// todo: consider reversing filename
const { Transform } = require("stream");
//const debug = require("debug")("unblocker:rewrite-css");
const contentTypes = require("./content-types");
const { fixUrl, urlNeedsFixed } = require("./rewrite-html");

module.exports = function CssRewriter(config) {
  // todo: share this with the front-end code instead of duplicating it
  const reCssUrl = /(url\s*\(\s*['"]?)([^'")]+)(['"]?\s*\))/gi;
  function fixCSS(css, baseUrl, config) {
    return css.replace(reCssUrl, function (match, open, url, close) {
      if (url !== url.trim()) {
        console.log("caught extra whitespace", arguments);
      }
      // todo use a wrapHref that operates on strings to avoid trimming trailing whitespace
      if (urlNeedsFixed(url)) {
        return open + fixUrl(config, url, baseUrl) + close;
      } else {
        return match;
      }
    });
  }

  const re_abs_url = /(["'=]|url\(\s*)(https?:)/gi; // "http:, 'http:, =http:, or url( http:, also matches https versions
  const re_rel_proto = /(["'=]|url\(\s*)(\/\/\w)/gi; // matches //site.com style urls where the protocol is auto-sensed
  const re_rel_root = /((href=|src=|action=|url\(\s*)['"]?)(\/.)/gi; // matches root-relative urls like /foo/bar.html
  // no need to match href="asdf/adf" relative links - those will work without modification

  // partial's don't cause anything to get changed, they just cause last few characters to be buffered and checked with the next batch
  const re_html_partial = /((url\(\s*)?\s\S+\s*)$/; // capture the last two "words" and any space after them handles chunks ending in things like `<a href=` and `background-image: url( ` or `url h`

  function rewriteUrls(css, url, prefix) {
    // first upgrade // links to regular http/https links because otherwise they look like root-relative (/whatever.html) links
    css = css.replace(re_rel_proto, "$1" + url.protocol + "$2");
    // next replace urls that are relative to the root of the domain (/whatever.html) because this is how proxied urls look
    css = css.replace(
      re_rel_root,
      "$1" + url.protocol + "//" + url.host + "$3"
    );
    // last replace any complete urls
    css = css.replace(re_abs_url, "$1" + prefix + "$2");

    return css;
  }

  function createStream(uri) {
    // sometimes a chunk will end in data that may need to be modified, but it is impossible to tell
    // in that case, buffer the end and prepend it to the next chunk
    let chunk_remainder;

    // todo: simplify this - make it use the fixCss method + make a simpler chunk saving regex
    return new Transform({
      decodeStrings: false,

      transform: function (chunk, encoding, next) {
        chunk = chunk.toString();
        if (chunk_remainder) {
          chunk = chunk_remainder + chunk;
          chunk_remainder = undefined;
        }

        // second, check if any urls are partially present in the end of the chunk,
        // and buffer the end of the chunk if so; otherwise pass it along
        const partial_hits = chunk.match(re_html_partial);
        if (partial_hits && partial_hits[1]) {
          const snip = partial_hits[1].length;
          chunk_remainder = chunk.substr(-1 * snip);
          chunk = chunk.substr(0, chunk.length - snip);
        }

        chunk = rewriteUrls(chunk, uri, config.prefix);

        this.push(chunk);
        next();
      },

      flush: function (done) {
        // if we buffered a bit of text but we're now at the end of the data, then apparently
        // it wasn't a url - send it along
        if (chunk_remainder) {
          this.push(rewriteUrls(chunk_remainder, uri, config.prefix));
          chunk_remainder = undefined;
        }
        done();
      },
    });
  }

  function handleResponse(data) {
    if (data.html) {
      data.html.on("startTag", ({ startTag }) => {
        // todo make the html parser identify these and emit style events
        startTag.attrs.forEach((attr) => {
          if (attr.name === "style") {
            attr.value = fixCSS(attr.value, data.url, config);
          }
        });
      });
      data.html.on("style", (event) => {
        event.source = fixCSS(event.source, data.url, config);
      });
    } else if (contentTypes.css.includes(data.contentType)) {
      data.stream = data.stream.pipe(createStream(data.url));
    }
  }

  return {
    fixCSS,
    createStream,
    handleResponse,
  };
};