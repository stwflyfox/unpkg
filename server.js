'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var cors = _interopDefault(require('cors'));
var express = _interopDefault(require('express'));
var morgan = _interopDefault(require('morgan'));
var path = _interopDefault(require('path'));
var tar = _interopDefault(require('tar-stream'));
var mime = _interopDefault(require('mime'));
var SRIToolbox = _interopDefault(require('sri-toolbox'));
var url = _interopDefault(require('url'));
var http = _interopDefault(require('http'));
var gunzip = _interopDefault(require('gunzip-maybe'));
var LRUCache = _interopDefault(require('lru-cache'));
var server$1 = require('react-dom/server');
var semver = _interopDefault(require('semver'));
var core = require('@emotion/core');
var React = require('react');
var React__default = _interopDefault(React);
var PropTypes = _interopDefault(require('prop-types'));
var VisuallyHidden = _interopDefault(require('@reach/visually-hidden'));
var sortBy = _interopDefault(require('sort-by'));
var formatBytes = _interopDefault(require('pretty-bytes'));
var jsesc = _interopDefault(require('jsesc'));
var hljs = _interopDefault(require('highlight.js'));
var etag = _interopDefault(require('etag'));
var cheerio = _interopDefault(require('cheerio'));
var babel = _interopDefault(require('@babel/core'));
var URL = _interopDefault(require('whatwg-url'));
var warning = _interopDefault(require('warning'));
var dateFns = require('date-fns');
var fetch = _interopDefault(require('isomorphic-fetch'));
var util = _interopDefault(require('util'));
var validateNpmPackageName = _interopDefault(require('validate-npm-package-name'));

/**
 * Useful for wrapping `async` request handlers in Express
 * so they automatically propagate errors.
 */
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(error => {
      req.log.error(`Unexpected error in ${handler.name}!`);
      req.log.error(error.stack);
      next(error);
    });
  };
}

function bufferStream(stream) {
  return new Promise((accept, reject) => {
    const chunks = [];
    stream.on('error', reject).on('data', chunk => chunks.push(chunk)).on('end', () => accept(Buffer.concat(chunks)));
  });
}

mime.define({
  'text/plain': ['authors', 'changes', 'license', 'makefile', 'patents', 'readme', 'ts', 'flow']
},
/* force */
true);
const textFiles = /\/?(\.[a-z]*rc|\.git[a-z]*|\.[a-z]*ignore|\.lock)$/i;
function getContentType(file) {
  const name = path.basename(file);
  return textFiles.test(name) ? 'text/plain' : mime.getType(name) || 'text/plain';
}

function getIntegrity(data) {
  return SRIToolbox.generate({
    algorithms: ['sha384']
  }, data);
}

//存放私库包的命名空间
const scopes = ['@shqy'];
/****
 * 私库地址，代理端口会解析url的端口号
 * const privateNpmRegistryURLArr = privateNpmRegistryURL.split(":");
 * const privateNpmPort = privateNpmRegistryURLArr[privateNpmRegistryURLArr.length - 1]
 * 拉取一些npm的包会返回302的情况，unpkg暂时没有处理，会不会和本地的npm源有关？
 ***/

const privateNpmRegistryURL = 'http://localhost:4873'; //互联网npm地址

const publicNpmRegistryURL = 'http://registry.npmmirror.com';

const npmRegistryURLPrivate = privateNpmRegistryURL; // 公网npm地址

const npmRegistryURL = publicNpmRegistryURL;
const privateNpmRegistryURLArr = privateNpmRegistryURL.split(":"); //获取私库的端口

const privateNpmPort = privateNpmRegistryURLArr[privateNpmRegistryURLArr.length - 1]; // const agent = new https.Agent({
//   keepAlive: true
// });

const agent = new http.Agent({
  keepAlive: true
});
const oneMegabyte = 1024 * 1024;
const oneSecond = 1000;
const oneMinute = oneSecond * 60;
const cache = new LRUCache({
  max: oneMegabyte * 40,
  length: Buffer.byteLength,
  maxAge: oneSecond
});
const notFound = '';

function get(options) {
  return new Promise((accept, reject) => {
    http.get(options, accept).on('error', reject);
  });
}

function isScopedPackageName(packageName) {
  return packageName.startsWith('@');
}

function encodePackageName(packageName) {
  return isScopedPackageName(packageName) ? `@${encodeURIComponent(packageName.substring(1))}` : encodeURIComponent(packageName);
}

function getIsPrivate(packageName) {
  return scopes.some(val => packageName.indexOf(val) !== -1);
}

async function fetchPackageInfo(packageName, log) {
  const name = encodePackageName(packageName);
  const isPrivatePage = getIsPrivate(packageName);
  let options = null;
  let infoURL = null;

  if (isPrivatePage) {
    //私库的包
    infoURL = `${npmRegistryURLPrivate}/${name}`;
  } else {
    infoURL = `${npmRegistryURL}/${name}`;
  }

  log.debug('Fetching package info for %s from %s', packageName, infoURL);
  const {
    hostname,
    pathname
  } = url.parse(infoURL);
  options = {
    hostname: hostname,
    path: pathname,
    headers: {
      Accept: 'application/json'
    }
  };

  if (isPrivatePage) {
    /*
    * http.Agent 主要是为 http.request, http.get 提供代理服务
    * 使用 keepAlive 代理，有效的减少了建立/销毁连接的开销
    * port 设置私库的端口，如果不设置，默认http默认使用80，https默认使用443
    *
    */
    const agentPrivate = new http.Agent({
      keepAlive: true,
      port: privateNpmPort
    });
    options.agent = agentPrivate;
  } else {
    options.agent = agent;
  }

  const res = await get(options);

  if (res.statusCode === 200) {
    return bufferStream(res).then(JSON.parse);
  }

  if (res.statusCode === 404) {
    return null;
  }

  console.log("request info======>", infoURL, res.statusCode);
  const content = (await bufferStream(res)).toString('utf-8');
  log.error('Error fetching info for %s (status: %s)', packageName, res.statusCode);
  log.error(content);
  return null;
}

async function fetchVersionsAndTags(packageName, log) {
  const info = await fetchPackageInfo(packageName, log);
  return info && info.versions ? {
    versions: Object.keys(info.versions),
    tags: info['dist-tags']
  } : null;
}
/**
 * Returns an object of available { versions, tags }.
 * Uses a cache to avoid over-fetching from the registry.
 */


async function getVersionsAndTags(packageName, log) {
  const cacheKey = `versions-${packageName}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchVersionsAndTags(packageName, log);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
} // All the keys that sometimes appear in package info
// docs that we don't need. There are probably more.

const packageConfigExcludeKeys = ['browserify', 'bugs', 'directories', 'engines', 'files', 'homepage', 'keywords', 'maintainers', 'scripts'];

function cleanPackageConfig(config) {
  return Object.keys(config).reduce((memo, key) => {
    if (!key.startsWith('_') && !packageConfigExcludeKeys.includes(key)) {
      memo[key] = config[key];
    }

    return memo;
  }, {});
}

async function fetchPackageConfig(packageName, version, log) {
  const info = await fetchPackageInfo(packageName, log);
  return info && info.versions && version in info.versions ? cleanPackageConfig(info.versions[version]) : null;
}
/**
 * Returns metadata about a package, mostly the same as package.json.
 * Uses a cache to avoid over-fetching from the registry.
 */


async function getPackageConfig(packageName, version, log) {
  const cacheKey = `config-${packageName}-${version}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchPackageConfig(packageName, version, log);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
}
/**
 * Returns a stream of the tarball'd contents of the given package.
 */

async function getPackage(packageName, version, log) {
  // const tarballName = isScopedPackageName(packageName)
  //   ? packageName.split('/')[1]
  //   : packageName;
  // const tarballURL = `${npmRegistryURL}/${packageName}/-/${tarballName}-${version}.tgz`;
  // 这里会被切割@，外网不会
  // 获取正确的包的url
  let tarballURL = null;
  const isPrivatePage = getIsPrivate(packageName);

  if (isPrivatePage) {
    tarballURL = `${npmRegistryURLPrivate}/${packageName}/-/${packageName}-${version}.tgz`;
  } else {
    const tarballName = isScopedPackageName(packageName) ? packageName.split('/')[1] : packageName;
    tarballURL = `${npmRegistryURL}/${packageName}/-/${tarballName}-${version}.tgz`;
  }

  log.debug('Fetching package for %s from %s', packageName, tarballURL);
  const {
    hostname,
    pathname
  } = url.parse(tarballURL);
  const options = {
    agent: agent,
    hostname: hostname,
    path: pathname
  };

  if (isPrivatePage) {
    /*
    * http.Agent 主要是为 http.request, http.get 提供代理服务
    * 使用 keepAlive 代理，有效的减少了建立/销毁连接的开销
    * port 设置私库的端口，如果不设置，默认http默认使用80，https默认使用443
    *
    */
    const agentPrivate = new http.Agent({
      keepAlive: true,
      port: privateNpmPort
    });
    options.agent = agentPrivate;
  } else {
    options.agent = agent;
  }

  const res = await get(options);

  if (res.statusCode === 200) {
    const stream = res.pipe(gunzip()); // stream.pause();

    return stream;
  }

  if (res.statusCode === 404) {
    return null;
  }

  console.log("request info======>", tarballURL, res.statusCode);
  const content = (await bufferStream(res)).toString('utf-8');
  log.error('Error fetching tarball for %s@%s (status: %s)', packageName, version, res.statusCode);
  log.error(content);
  return null;
}

function _extends() {
  _extends = Object.assign || function (target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];

      for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }

    return target;
  };

  return _extends.apply(this, arguments);
}

function _objectWithoutPropertiesLoose(source, excluded) {
  if (source == null) return {};
  var target = {};
  var sourceKeys = Object.keys(source);
  var key, i;

  for (i = 0; i < sourceKeys.length; i++) {
    key = sourceKeys[i];
    if (excluded.indexOf(key) >= 0) continue;
    target[key] = source[key];
  }

  return target;
}

function _taggedTemplateLiteralLoose(strings, raw) {
  if (!raw) {
    raw = strings.slice(0);
  }

  strings.raw = raw;
  return strings;
}

var fontSans = "\nfont-family: -apple-system,\n  BlinkMacSystemFont,\n  \"Segoe UI\",\n  \"Roboto\",\n  \"Oxygen\",\n  \"Ubuntu\",\n  \"Cantarell\",\n  \"Fira Sans\",\n  \"Droid Sans\",\n  \"Helvetica Neue\",\n  sans-serif;\n";
var fontMono = "\nfont-family: Menlo,\n  Monaco,\n  Lucida Console,\n  Liberation Mono,\n  DejaVu Sans Mono,\n  Bitstream Vera Sans Mono,\n  Courier New,\n  monospace;\n";

var Context = React.createContext();
function PackageInfoProvider(_ref) {
  var children = _ref.children,
      rest = _objectWithoutPropertiesLoose(_ref, ["children"]);

  return React__default.createElement(Context.Provider, {
    children: children,
    value: rest
  });
}
function usePackageInfo() {
  return React.useContext(Context);
}

function formatNumber(n) {
  var digits = String(n).split('');
  var groups = [];

  while (digits.length) {
    groups.unshift(digits.splice(-3).join(''));
  }

  return groups.join(',');
}
function formatPercent(n, decimals) {
  if (decimals === void 0) {
    decimals = 1;
  }

  return (n * 100).toPrecision(decimals + 2);
}

var DefaultContext = {
  color: undefined,
  size: undefined,
  className: undefined,
  style: undefined,
  attr: undefined
};
var IconContext = React.createContext && React.createContext(DefaultContext);

var __assign = undefined && undefined.__assign || function () {
  __assign = Object.assign || function (t) {
    for (var s, i = 1, n = arguments.length; i < n; i++) {
      s = arguments[i];

      for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
    }

    return t;
  };

  return __assign.apply(this, arguments);
};

var __rest = undefined && undefined.__rest || function (s, e) {
  var t = {};

  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];

  if (s != null && typeof Object.getOwnPropertySymbols === "function") for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) if (e.indexOf(p[i]) < 0) t[p[i]] = s[p[i]];
  return t;
};

function Tree2Element(tree) {
  return tree && tree.map(function (node, i) {
    return React.createElement(node.tag, __assign({
      key: i
    }, node.attr), Tree2Element(node.child));
  });
}

function GenIcon(data) {
  return function (props) {
    return React.createElement(IconBase, __assign({
      attr: __assign({}, data.attr)
    }, props), Tree2Element(data.child));
  };
}
function IconBase(props) {
  var elem = function (conf) {
    var computedSize = props.size || conf.size || "1em";
    var className;
    if (conf.className) className = conf.className;
    if (props.className) className = (className ? className + ' ' : '') + props.className;

    var attr = props.attr,
        title = props.title,
        svgProps = __rest(props, ["attr", "title"]);

    return React.createElement("svg", __assign({
      stroke: "currentColor",
      fill: "currentColor",
      strokeWidth: "0"
    }, conf.attr, attr, svgProps, {
      className: className,
      style: __assign({
        color: props.color || conf.color
      }, conf.style, props.style),
      height: computedSize,
      width: computedSize,
      xmlns: "http://www.w3.org/2000/svg"
    }), title && React.createElement("title", null, title), props.children);
  };

  return IconContext !== undefined ? React.createElement(IconContext.Consumer, null, function (conf) {
    return elem(conf);
  }) : elem(DefaultContext);
}

// THIS FILE IS AUTO GENERATED
var GoFileDirectory = function (props) {
  return GenIcon({"tag":"svg","attr":{"viewBox":"0 0 14 16"},"child":[{"tag":"path","attr":{"fillRule":"evenodd","d":"M13 4H7V3c0-.66-.31-1-1-1H1c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1V5c0-.55-.45-1-1-1zM6 4H1V3h5v1z"}}]})(props);
};
GoFileDirectory.displayName = "GoFileDirectory";
var GoFile = function (props) {
  return GenIcon({"tag":"svg","attr":{"viewBox":"0 0 12 16"},"child":[{"tag":"path","attr":{"fillRule":"evenodd","d":"M6 5H2V4h4v1zM2 8h7V7H2v1zm0 2h7V9H2v1zm0 2h7v-1H2v1zm10-7.5V14c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V2c0-.55.45-1 1-1h7.5L12 4.5zM11 5L8 2H1v12h10V5z"}}]})(props);
};
GoFile.displayName = "GoFile";

// THIS FILE IS AUTO GENERATED
var FaGithub = function (props) {
  return GenIcon({"tag":"svg","attr":{"viewBox":"0 0 496 512"},"child":[{"tag":"path","attr":{"d":"M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8zM97.2 352.9c-1.3 1-1 3.3.7 5.2 1.6 1.6 3.9 2.3 5.2 1 1.3-1 1-3.3-.7-5.2-1.6-1.6-3.9-2.3-5.2-1zm-10.8-8.1c-.7 1.3.3 2.9 2.3 3.9 1.6 1 3.6.7 4.3-.7.7-1.3-.3-2.9-2.3-3.9-2-.6-3.6-.3-4.3.7zm32.4 35.6c-1.6 1.3-1 4.3 1.3 6.2 2.3 2.3 5.2 2.6 6.5 1 1.3-1.3.7-4.3-1.3-6.2-2.2-2.3-5.2-2.6-6.5-1zm-11.4-14.7c-1.6 1-1.6 3.6 0 5.9 1.6 2.3 4.3 3.3 5.6 2.3 1.6-1.3 1.6-3.9 0-6.2-1.4-2.3-4-3.3-5.6-2z"}}]})(props);
};
FaGithub.displayName = "FaGithub";
var FaTwitter = function (props) {
  return GenIcon({"tag":"svg","attr":{"viewBox":"0 0 512 512"},"child":[{"tag":"path","attr":{"d":"M459.37 151.716c.325 4.548.325 9.097.325 13.645 0 138.72-105.583 298.558-298.558 298.558-59.452 0-114.68-17.219-161.137-47.106 8.447.974 16.568 1.299 25.34 1.299 49.055 0 94.213-16.568 130.274-44.832-46.132-.975-84.792-31.188-98.112-72.772 6.498.974 12.995 1.624 19.818 1.624 9.421 0 18.843-1.3 27.614-3.573-48.081-9.747-84.143-51.98-84.143-102.985v-1.299c13.969 7.797 30.214 12.67 47.431 13.319-28.264-18.843-46.781-51.005-46.781-87.391 0-19.492 5.197-37.36 14.294-52.954 51.655 63.675 129.3 105.258 216.365 109.807-1.624-7.797-2.599-15.918-2.599-24.04 0-57.828 46.782-104.934 104.934-104.934 30.213 0 57.502 12.67 76.67 33.137 23.715-4.548 46.456-13.32 66.599-25.34-7.798 24.366-24.366 44.833-46.132 57.827 21.117-2.273 41.584-8.122 60.426-16.243-14.292 20.791-32.161 39.308-52.628 54.253z"}}]})(props);
};
FaTwitter.displayName = "FaTwitter";

function createIcon(Type, _ref) {
  var css = _ref.css,
      rest = _objectWithoutPropertiesLoose(_ref, ["css"]);

  return core.jsx(Type, _extends({
    css: _extends({}, css, {
      verticalAlign: 'text-bottom'
    })
  }, rest));
}

function DirectoryIcon(props) {
  return createIcon(GoFileDirectory, props);
}
function CodeFileIcon(props) {
  return createIcon(GoFile, props);
}
function TwitterIcon(props) {
  return createIcon(FaTwitter, props);
}
function GitHubIcon(props) {
  return createIcon(FaGithub, props);
}

var linkStyle = {
  color: '#0076ff',
  textDecoration: 'none',
  ':hover': {
    textDecoration: 'underline'
  }
};
var tableCellStyle = {
  paddingTop: 6,
  paddingRight: 3,
  paddingBottom: 6,
  paddingLeft: 3,
  borderTop: '1px solid #eaecef'
};

var iconCellStyle = _extends({}, tableCellStyle, {
  color: '#424242',
  width: 17,
  paddingRight: 2,
  paddingLeft: 10,
  '@media (max-width: 700px)': {
    paddingLeft: 20
  }
});

var typeCellStyle = _extends({}, tableCellStyle, {
  textAlign: 'right',
  paddingRight: 10,
  '@media (max-width: 700px)': {
    paddingRight: 20
  }
});

function getRelName(path, base) {
  return path.substr(base.length > 1 ? base.length + 1 : 1);
}

function DirectoryViewer(_ref) {
  var path = _ref.path,
      entries = _ref.details;
  var rows = [];

  if (path !== '/') {
    rows.push(core.jsx("tr", {
      key: ".."
    }, core.jsx("td", {
      css: iconCellStyle
    }), core.jsx("td", {
      css: tableCellStyle
    }, core.jsx("a", {
      title: "Parent directory",
      href: "../",
      css: linkStyle
    }, "..")), core.jsx("td", {
      css: tableCellStyle
    }), core.jsx("td", {
      css: typeCellStyle
    })));
  }

  var _Object$keys$reduce = Object.keys(entries).reduce(function (memo, key) {
    var subdirs = memo.subdirs,
        files = memo.files;
    var entry = entries[key];

    if (entry.type === 'directory') {
      subdirs.push(entry);
    } else if (entry.type === 'file') {
      files.push(entry);
    }

    return memo;
  }, {
    subdirs: [],
    files: []
  }),
      subdirs = _Object$keys$reduce.subdirs,
      files = _Object$keys$reduce.files;

  subdirs.sort(sortBy('path')).forEach(function (_ref2) {
    var dirname = _ref2.path;
    var relName = getRelName(dirname, path);
    var href = relName + '/';
    rows.push(core.jsx("tr", {
      key: relName
    }, core.jsx("td", {
      css: iconCellStyle
    }, core.jsx(DirectoryIcon, null)), core.jsx("td", {
      css: tableCellStyle
    }, core.jsx("a", {
      title: relName,
      href: href,
      css: linkStyle
    }, relName)), core.jsx("td", {
      css: tableCellStyle
    }, "-"), core.jsx("td", {
      css: typeCellStyle
    }, "-")));
  });
  files.sort(sortBy('path')).forEach(function (_ref3) {
    var filename = _ref3.path,
        size = _ref3.size,
        contentType = _ref3.contentType;
    var relName = getRelName(filename, path);
    var href = relName;
    rows.push(core.jsx("tr", {
      key: relName
    }, core.jsx("td", {
      css: iconCellStyle
    }, core.jsx(CodeFileIcon, null)), core.jsx("td", {
      css: tableCellStyle
    }, core.jsx("a", {
      title: relName,
      href: href,
      css: linkStyle
    }, relName)), core.jsx("td", {
      css: tableCellStyle
    }, formatBytes(size)), core.jsx("td", {
      css: typeCellStyle
    }, contentType)));
  });
  return core.jsx("div", {
    css: {
      border: '1px solid #dfe2e5',
      borderRadius: 3,
      borderTopWidth: 0,
      '@media (max-width: 700px)': {
        borderRightWidth: 0,
        borderLeftWidth: 0
      }
    }
  }, core.jsx("table", {
    css: {
      width: '100%',
      borderCollapse: 'collapse',
      borderRadius: 2,
      background: '#fff',
      '@media (max-width: 700px)': {
        '& th + th + th + th, & td + td + td + td': {
          display: 'none'
        }
      }
    }
  }, core.jsx("thead", null, core.jsx("tr", null, core.jsx("th", null, core.jsx(VisuallyHidden, null, "Icon")), core.jsx("th", null, core.jsx(VisuallyHidden, null, "Name")), core.jsx("th", null, core.jsx(VisuallyHidden, null, "Size")), core.jsx("th", null, core.jsx(VisuallyHidden, null, "Content Type")))), core.jsx("tbody", null, rows)));
}

if (process.env.NODE_ENV !== 'production') {
  DirectoryViewer.propTypes = {
    path: PropTypes.string.isRequired,
    details: PropTypes.objectOf(PropTypes.shape({
      path: PropTypes.string.isRequired,
      type: PropTypes.oneOf(['directory', 'file']).isRequired,
      contentType: PropTypes.string,
      // file only
      integrity: PropTypes.string,
      // file only
      size: PropTypes.number // file only

    })).isRequired
  };
}

function createHTML(content) {
  return {
    __html: content
  };
}

/** @jsx jsx */

function getBasename(path) {
  var segments = path.split('/');
  return segments[segments.length - 1];
}

function ImageViewer(_ref) {
  var path = _ref.path,
      uri = _ref.uri;
  return core.jsx("div", {
    css: {
      padding: 20,
      textAlign: 'center'
    }
  }, core.jsx("img", {
    title: getBasename(path),
    src: uri
  }));
}

function CodeListing(_ref2) {
  var highlights = _ref2.highlights;
  var lines = highlights.slice(0);
  var hasTrailingNewline = lines.length && lines[lines.length - 1] === '';

  if (hasTrailingNewline) {
    lines.pop();
  }

  return core.jsx("div", {
    className: "code-listing",
    css: {
      overflowX: 'auto',
      overflowY: 'hidden',
      paddingTop: 5,
      paddingBottom: 5
    }
  }, core.jsx("table", {
    css: {
      border: 'none',
      borderCollapse: 'collapse',
      borderSpacing: 0
    }
  }, core.jsx("tbody", null, lines.map(function (line, index) {
    var lineNumber = index + 1;
    return core.jsx("tr", {
      key: index
    }, core.jsx("td", {
      id: "L" + lineNumber,
      css: {
        paddingLeft: 10,
        paddingRight: 10,
        color: 'rgba(27,31,35,.3)',
        textAlign: 'right',
        verticalAlign: 'top',
        width: '1%',
        minWidth: 50,
        userSelect: 'none'
      }
    }, core.jsx("span", null, lineNumber)), core.jsx("td", {
      id: "LC" + lineNumber,
      css: {
        paddingLeft: 10,
        paddingRight: 10,
        color: '#24292e',
        whiteSpace: 'pre'
      }
    }, core.jsx("code", {
      dangerouslySetInnerHTML: createHTML(line)
    })));
  }), !hasTrailingNewline && core.jsx("tr", {
    key: "no-newline"
  }, core.jsx("td", {
    css: {
      paddingLeft: 10,
      paddingRight: 10,
      color: 'rgba(27,31,35,.3)',
      textAlign: 'right',
      verticalAlign: 'top',
      width: '1%',
      minWidth: 50,
      userSelect: 'none'
    }
  }, "\\"), core.jsx("td", {
    css: {
      paddingLeft: 10,
      color: 'rgba(27,31,35,.3)',
      userSelect: 'none'
    }
  }, "No newline at end of file")))));
}

function BinaryViewer() {
  return core.jsx("div", {
    css: {
      padding: 20
    }
  }, core.jsx("p", {
    css: {
      textAlign: 'center'
    }
  }, "No preview available."));
}

function FileViewer(_ref3) {
  var path = _ref3.path,
      details = _ref3.details;

  var _usePackageInfo = usePackageInfo(),
      packageName = _usePackageInfo.packageName,
      packageVersion = _usePackageInfo.packageVersion;

  var highlights = details.highlights,
      uri = details.uri,
      language = details.language,
      size = details.size;
  var segments = path.split('/');
  var filename = segments[segments.length - 1];
  return core.jsx("div", {
    css: {
      border: '1px solid #dfe2e5',
      borderRadius: 3,
      '@media (max-width: 700px)': {
        borderRightWidth: 0,
        borderLeftWidth: 0
      }
    }
  }, core.jsx("div", {
    css: {
      padding: 10,
      background: '#f6f8fa',
      color: '#424242',
      border: '1px solid #d1d5da',
      borderTopLeftRadius: 3,
      borderTopRightRadius: 3,
      margin: '-1px -1px 0',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      '@media (max-width: 700px)': {
        paddingRight: 20,
        paddingLeft: 20
      }
    }
  }, core.jsx("span", null, formatBytes(size)), " ", core.jsx("span", null, language), ' ', core.jsx("a", {
    title: filename,
    href: "/" + packageName + "@" + packageVersion + path,
    css: {
      display: 'inline-block',
      textDecoration: 'none',
      padding: '2px 8px',
      fontWeight: 600,
      fontSize: '0.9rem',
      color: '#24292e',
      backgroundColor: '#eff3f6',
      border: '1px solid rgba(27,31,35,.2)',
      borderRadius: 3,
      ':hover': {
        backgroundColor: '#e6ebf1',
        borderColor: 'rgba(27,31,35,.35)'
      },
      ':active': {
        backgroundColor: '#e9ecef',
        borderColor: 'rgba(27,31,35,.35)',
        boxShadow: 'inset 0 0.15em 0.3em rgba(27,31,35,.15)'
      }
    }
  }, "View Raw")), highlights ? core.jsx(CodeListing, {
    highlights: highlights
  }) : uri ? core.jsx(ImageViewer, {
    path: path,
    uri: uri
  }) : core.jsx(BinaryViewer, null));
}

if (process.env.NODE_ENV !== 'production') {
  FileViewer.propTypes = {
    path: PropTypes.string.isRequired,
    details: PropTypes.shape({
      contentType: PropTypes.string.isRequired,
      highlights: PropTypes.arrayOf(PropTypes.string),
      // code
      uri: PropTypes.string,
      // images
      integrity: PropTypes.string.isRequired,
      language: PropTypes.string.isRequired,
      size: PropTypes.number.isRequired
    }).isRequired
  };
}

var SelectDownArrow = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAAXNSR0IArs4c6QAAARFJREFUKBVjZAACNS39RhBNKrh17WI9o4quoT3Dn78HSNUMUs/CzOTI/O7Vi4dCYpJ3/jP+92BkYGAlyiBGhm8MjIxJt65e3MQM0vDu9YvLYmISILYZELOBxHABRkaGr0yMzF23r12YDFIDNgDEePv65SEhEXENBkYGFSAXuyGMjF8Z/jOsvX3tYiFIDwgwQSgIaaijnvj/P8M5IO8HsjiY/f//D4b//88A1SQhywG9jQr09PS4v/1mPAeUUPzP8B8cJowMjL+Bqu6xMQmaXL164AuyDgwDQJLa2qYSP//9vARkCoMVMzK8YeVkNbh+9uxzMB+JwGoASF5Vx0jz/98/18BqmZi171w9D2EjaaYKEwAEK00XQLdJuwAAAABJRU5ErkJggg==";

function _templateObject2() {
  var data = _taggedTemplateLiteralLoose(["\n  .code-listing {\n    background: #fbfdff;\n    color: #383a42;\n  }\n  .code-comment,\n  .code-quote {\n    color: #a0a1a7;\n    font-style: italic;\n  }\n  .code-doctag,\n  .code-keyword,\n  .code-link,\n  .code-formula {\n    color: #a626a4;\n  }\n  .code-section,\n  .code-name,\n  .code-selector-tag,\n  .code-deletion,\n  .code-subst {\n    color: #e45649;\n  }\n  .code-literal {\n    color: #0184bb;\n  }\n  .code-string,\n  .code-regexp,\n  .code-addition,\n  .code-attribute,\n  .code-meta-string {\n    color: #50a14f;\n  }\n  .code-built_in,\n  .code-class .code-title {\n    color: #c18401;\n  }\n  .code-attr,\n  .code-variable,\n  .code-template-variable,\n  .code-type,\n  .code-selector-class,\n  .code-selector-attr,\n  .code-selector-pseudo,\n  .code-number {\n    color: #986801;\n  }\n  .code-symbol,\n  .code-bullet,\n  .code-meta,\n  .code-selector-id,\n  .code-title {\n    color: #4078f2;\n  }\n  .code-emphasis {\n    font-style: italic;\n  }\n  .code-strong {\n    font-weight: bold;\n  }\n"]);

  _templateObject2 = function _templateObject2() {
    return data;
  };

  return data;
}

function _templateObject() {
  var data = _taggedTemplateLiteralLoose(["\n  html {\n    box-sizing: border-box;\n  }\n  *,\n  *:before,\n  *:after {\n    box-sizing: inherit;\n  }\n\n  html,\n  body,\n  #root {\n    height: 100%;\n    margin: 0;\n  }\n\n  body {\n    ", "\n    font-size: 16px;\n    line-height: 1.5;\n    background: white;\n    color: black;\n  }\n\n  code {\n    ", "\n  }\n\n  th,\n  td {\n    padding: 0;\n  }\n\n  select {\n    font-size: inherit;\n  }\n\n  #root {\n    display: flex;\n    flex-direction: column;\n  }\n"]);

  _templateObject = function _templateObject() {
    return data;
  };

  return data;
}
var globalStyles = core.css(_templateObject(), fontSans, fontMono); // Adapted from https://github.com/highlightjs/highlight.js/blob/master/src/styles/atom-one-light.css

var lightCodeStyles = core.css(_templateObject2());
var linkStyle$1 = {
  color: '#0076ff',
  textDecoration: 'none',
  ':hover': {
    textDecoration: 'underline'
  }
};
function App(_ref) {
  var packageName = _ref.packageName,
      packageVersion = _ref.packageVersion,
      _ref$availableVersion = _ref.availableVersions,
      availableVersions = _ref$availableVersion === void 0 ? [] : _ref$availableVersion,
      filename = _ref.filename,
      target = _ref.target;

  function handleChange(event) {
    window.location.href = window.location.href.replace('@' + packageVersion, '@' + event.target.value);
  }

  var breadcrumbs = [];

  if (filename === '/') {
    breadcrumbs.push(packageName);
  } else {
    var url = "/browse/" + packageName + "@" + packageVersion;
    breadcrumbs.push(core.jsx("a", {
      href: url + "/",
      css: linkStyle$1
    }, packageName));
    var segments = filename.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    var lastSegment = segments.pop();
    segments.forEach(function (segment) {
      url += "/" + segment;
      breadcrumbs.push(core.jsx("a", {
        href: url + "/",
        css: linkStyle$1
      }, segment));
    });
    breadcrumbs.push(lastSegment);
  } // TODO: Provide a user pref to go full width?


  var maxContentWidth = 940;
  return core.jsx(PackageInfoProvider, {
    packageName: packageName,
    packageVersion: packageVersion
  }, core.jsx(React.Fragment, null, core.jsx(core.Global, {
    styles: globalStyles
  }), core.jsx(core.Global, {
    styles: lightCodeStyles
  }), core.jsx("div", {
    css: {
      flex: '1 0 auto'
    }
  }, core.jsx("div", {
    css: {
      maxWidth: maxContentWidth,
      padding: '0 20px',
      margin: '0 auto'
    }
  }, core.jsx("header", {
    css: {
      textAlign: 'center'
    }
  }, core.jsx("h1", {
    css: {
      fontSize: '3rem',
      marginTop: '2rem'
    }
  }, core.jsx("a", {
    href: "/",
    css: {
      color: '#000',
      textDecoration: 'none'
    }
  }, "UNPKG"))), core.jsx("header", {
    css: {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      '@media (max-width: 700px)': {
        flexDirection: 'column-reverse',
        alignItems: 'flex-start'
      }
    }
  }, core.jsx("h1", {
    css: {
      fontSize: '1.5rem',
      fontWeight: 'normal',
      flex: 1
    }
  }, core.jsx("nav", null, breadcrumbs.map(function (item, index, array) {
    return core.jsx("span", {
      key: index
    }, index !== 0 && core.jsx("span", {
      css: {
        paddingLeft: 5,
        paddingRight: 5
      }
    }, "/"), index === array.length - 1 ? core.jsx("strong", null, item) : item);
  }))), core.jsx("p", {
    css: {
      marginLeft: 20,
      '@media (max-width: 700px)': {
        marginLeft: 0,
        marginBottom: 0
      }
    }
  }, core.jsx("label", null, "Version:", ' ', core.jsx("select", {
    name: "version",
    defaultValue: packageVersion,
    onChange: handleChange,
    css: {
      appearance: 'none',
      cursor: 'pointer',
      padding: '4px 24px 4px 8px',
      fontWeight: 600,
      fontSize: '0.9em',
      color: '#24292e',
      border: '1px solid rgba(27,31,35,.2)',
      borderRadius: 3,
      backgroundColor: '#eff3f6',
      backgroundImage: "url(" + SelectDownArrow + ")",
      backgroundPosition: 'right 8px center',
      backgroundRepeat: 'no-repeat',
      backgroundSize: 'auto 25%',
      ':hover': {
        backgroundColor: '#e6ebf1',
        borderColor: 'rgba(27,31,35,.35)'
      },
      ':active': {
        backgroundColor: '#e9ecef',
        borderColor: 'rgba(27,31,35,.35)',
        boxShadow: 'inset 0 0.15em 0.3em rgba(27,31,35,.15)'
      }
    }
  }, availableVersions.map(function (v) {
    return core.jsx("option", {
      key: v,
      value: v
    }, v);
  })))))), core.jsx("div", {
    css: {
      maxWidth: maxContentWidth,
      padding: '0 20px',
      margin: '0 auto',
      '@media (max-width: 700px)': {
        padding: 0,
        margin: 0
      }
    }
  }, target.type === 'directory' ? core.jsx(DirectoryViewer, {
    path: target.path,
    details: target.details
  }) : target.type === 'file' ? core.jsx(FileViewer, {
    path: target.path,
    details: target.details
  }) : null)), core.jsx("footer", {
    css: {
      marginTop: '5rem',
      background: 'black',
      color: '#aaa'
    }
  }, core.jsx("div", {
    css: {
      maxWidth: maxContentWidth,
      padding: '10px 20px',
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, core.jsx("p", null, "\xA9 ", new Date().getFullYear(), " UNPKG"), core.jsx("p", {
    css: {
      fontSize: '1.5rem'
    }
  }, core.jsx("a", {
    title: "Twitter",
    href: "https://twitter.com/unpkg",
    css: {
      color: '#aaa',
      display: 'inline-block',
      ':hover': {
        color: 'white'
      }
    }
  }, core.jsx(TwitterIcon, null)), core.jsx("a", {
    title: "GitHub",
    href: "https://github.com/mjackson/unpkg",
    css: {
      color: '#aaa',
      display: 'inline-block',
      marginLeft: '1rem',
      ':hover': {
        color: 'white'
      }
    }
  }, core.jsx(GitHubIcon, null)))))));
}

if (process.env.NODE_ENV !== 'production') {
  var targetType = PropTypes.shape({
    path: PropTypes.string.isRequired,
    type: PropTypes.oneOf(['directory', 'file']).isRequired,
    details: PropTypes.object.isRequired
  });
  App.propTypes = {
    packageName: PropTypes.string.isRequired,
    packageVersion: PropTypes.string.isRequired,
    availableVersions: PropTypes.arrayOf(PropTypes.string),
    filename: PropTypes.string.isRequired,
    target: targetType.isRequired
  };
}

/**
 * Encodes some data as JSON that may safely be included in HTML.
 */

function encodeJSONForScript(data) {
  return jsesc(data, {
    json: true,
    isScriptContext: true
  });
}

function createHTML$1(code) {
  return {
    __html: code
  };
}
function createScript(script) {
  return React.createElement('script', {
    dangerouslySetInnerHTML: createHTML$1(script)
  });
}

const promiseShim = 'window.Promise || document.write(\'\\x3Cscript src="/es6-promise@4.2.5/dist/es6-promise.min.js">\\x3C/script>\\x3Cscript>ES6Promise.polyfill()\\x3C/script>\')';
const fetchShim = 'window.fetch || document.write(\'\\x3Cscript src="/whatwg-fetch@3.0.0/dist/fetch.umd.js">\\x3C/script>\')';
function MainTemplate({
  title = 'UNPKG',
  description = 'The CDN for everything on npm',
  favicon = '/favicon.ico',
  data,
  content = createHTML$1(''),
  elements = []
}) {
  return React.createElement('html', {
    lang: 'en'
  }, React.createElement('head', null, // Global site tag (gtag.js) - Google Analytics
  React.createElement('script', {
    async: true,
    src: 'https://www.googletagmanager.com/gtag/js?id=UA-140352188-1'
  }), createScript(`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'UA-140352188-1');`), React.createElement('meta', {
    charSet: 'utf-8'
  }), React.createElement('meta', {
    httpEquiv: 'X-UA-Compatible',
    content: 'IE=edge,chrome=1'
  }), description && React.createElement('meta', {
    name: 'description',
    content: description
  }), React.createElement('meta', {
    name: 'viewport',
    content: 'width=device-width,initial-scale=1,maximum-scale=1'
  }), React.createElement('meta', {
    name: 'timestamp',
    content: new Date().toISOString()
  }), favicon && React.createElement('link', {
    rel: 'shortcut icon',
    href: favicon
  }), React.createElement('title', null, title), createScript(promiseShim), createScript(fetchShim), data && createScript(`window.__DATA__ = ${encodeJSONForScript(data)}`)), React.createElement('body', null, React.createElement('div', {
    id: 'root',
    dangerouslySetInnerHTML: content
  }), ...elements));
}

if (process.env.NODE_ENV !== 'production') {
  const htmlType = PropTypes.shape({
    __html: PropTypes.string
  });
  MainTemplate.propTypes = {
    title: PropTypes.string,
    description: PropTypes.string,
    favicon: PropTypes.string,
    data: PropTypes.any,
    content: htmlType,
    elements: PropTypes.arrayOf(PropTypes.node)
  };
}

var entryManifest = [{"browse":[{"format":"iife","globalImports":["react","react-dom","@emotion/core"],"url":"/_client/browse-415baa3d.js","code":"'use strict';\n(function(t, z, c) {\n  function A() {\n    A = Object.assign || function(a) {\n      for (var b = 1; b < arguments.length; b++) {\n        var d = arguments[b], c;\n        for (c in d) {\n          Object.prototype.hasOwnProperty.call(d, c) && (a[c] = d[c]);\n        }\n      }\n      return a;\n    };\n    return A.apply(this, arguments);\n  }\n  function Q(a, b) {\n    if (null == a) {\n      return {};\n    }\n    var d = {}, c = Object.keys(a), f;\n    for (f = 0; f < c.length; f++) {\n      var k = c[f];\n      0 <= b.indexOf(k) || (d[k] = a[k]);\n    }\n    return d;\n  }\n  function R(a, b) {\n    b || (b = a.slice(0));\n    a.raw = b;\n    return a;\n  }\n  function S(a) {\n    return a && a.__esModule && Object.prototype.hasOwnProperty.call(a, \"default\") ? a[\"default\"] : a;\n  }\n  function D(a, b) {\n    return b = {exports:{}}, a(b, b.exports), b.exports;\n  }\n  function J(a, b, d, c, f) {\n    for (var k in a) {\n      if (sa(a, k)) {\n        try {\n          if (\"function\" !== typeof a[k]) {\n            var h = Error((c || \"React class\") + \": \" + d + \" type `\" + k + \"` is invalid; it must be a function, usually from the `prop-types` package, but received `\" + typeof a[k] + \"`.\");\n            h.name = \"Invariant Violation\";\n            throw h;\n          }\n          var l = a[k](b, k, c, d, null, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\");\n        } catch (q) {\n          l = q;\n        }\n        !l || l instanceof Error || K((c || \"React class\") + \": type specification of \" + d + \" `\" + k + \"` is invalid; the type checker function must return `null` or an `Error` but returned a \" + typeof l + \". You may have forgotten to pass an argument to the type checker creator (arrayOf, instanceOf, objectOf, oneOf, oneOfType, and shape all require an argument).\");\n        if (l instanceof Error && !(l.message in L)) {\n          L[l.message] = !0;\n          var B = f ? f() : \"\";\n          K(\"Failed \" + d + \" type: \" + l.message + (null != B ? B : \"\"));\n        }\n      }\n    }\n  }\n  function E() {\n    return null;\n  }\n  function ta(a) {\n    var b = a.children;\n    a = Q(a, [\"children\"]);\n    return M.createElement(T.Provider, {children:b, value:a});\n  }\n  function U(a) {\n    return a && a.map(function(a, d) {\n      return t.createElement(a.tag, y({key:d}, a.attr), U(a.child));\n    });\n  }\n  function F(a) {\n    return function(b) {\n      return t.createElement(ua, y({attr:y({}, a.attr)}, b), U(a.child));\n    };\n  }\n  function ua(a) {\n    var b = function(b) {\n      var c = a.size || b.size || \"1em\";\n      if (b.className) {\n        var d = b.className;\n      }\n      a.className && (d = (d ? d + \" \" : \"\") + a.className);\n      var k = a.attr, r = a.title, l = [\"attr\", \"title\"], B = {}, q;\n      for (q in a) {\n        Object.prototype.hasOwnProperty.call(a, q) && 0 > l.indexOf(q) && (B[q] = a[q]);\n      }\n      if (null != a && \"function\" === typeof Object.getOwnPropertySymbols) {\n        var p = 0;\n        for (q = Object.getOwnPropertySymbols(a); p < q.length; p++) {\n          0 > l.indexOf(q[p]) && (B[q[p]] = a[q[p]]);\n        }\n      }\n      return t.createElement(\"svg\", y({stroke:\"currentColor\", fill:\"currentColor\", strokeWidth:\"0\"}, b.attr, k, B, {className:d, style:y({color:a.color || b.color}, b.style, a.style), height:c, width:c, xmlns:\"http://www.w3.org/2000/svg\"}), r && t.createElement(\"title\", null, r), a.children);\n    };\n    return void 0 !== V ? t.createElement(V.Consumer, null, function(a) {\n      return b(a);\n    }) : b(W);\n  }\n  function G(a, b) {\n    var d = b.css;\n    b = Q(b, [\"css\"]);\n    return c.jsx(a, A({css:A({}, d, {verticalAlign:\"text-bottom\"})}, b));\n  }\n  function va(a) {\n    return G(X, a);\n  }\n  function wa(a) {\n    return G(Y, a);\n  }\n  function xa(a) {\n    return G(Z, a);\n  }\n  function ya(a) {\n    return G(aa, a);\n  }\n  function ba(a) {\n    var b = a.path, d = a.details, h = [];\n    \"/\" !== b && h.push(c.jsx(\"tr\", {key:\"..\"}, c.jsx(\"td\", {css:N}), c.jsx(\"td\", {css:x}, c.jsx(\"a\", {title:\"Parent directory\", href:\"../\", css:O}, \"..\")), c.jsx(\"td\", {css:x}), c.jsx(\"td\", {css:P})));\n    a = Object.keys(d).reduce(function(a, b) {\n      var c = a.subdirs, f = a.files;\n      b = d[b];\n      \"directory\" === b.type ? c.push(b) : \"file\" === b.type && f.push(b);\n      return a;\n    }, {subdirs:[], files:[]});\n    var f = a.files;\n    a.subdirs.sort(ca(\"path\")).forEach(function(a) {\n      a = a.path.substr(1 < b.length ? b.length + 1 : 1);\n      var d = a + \"/\";\n      h.push(c.jsx(\"tr\", {key:a}, c.jsx(\"td\", {css:N}, c.jsx(va, null)), c.jsx(\"td\", {css:x}, c.jsx(\"a\", {title:a, href:d, css:O}, a)), c.jsx(\"td\", {css:x}, \"-\"), c.jsx(\"td\", {css:P}, \"-\")));\n    });\n    f.sort(ca(\"path\")).forEach(function(a) {\n      var d = a.size, f = a.contentType;\n      a = a.path.substr(1 < b.length ? b.length + 1 : 1);\n      h.push(c.jsx(\"tr\", {key:a}, c.jsx(\"td\", {css:N}, c.jsx(wa, null)), c.jsx(\"td\", {css:x}, c.jsx(\"a\", {title:a, href:a, css:O}, a)), c.jsx(\"td\", {css:x}, da(d)), c.jsx(\"td\", {css:P}, f)));\n    });\n    return c.jsx(\"div\", {css:{border:\"1px solid #dfe2e5\", borderRadius:3, borderTopWidth:0, \"@media (max-width: 700px)\":{borderRightWidth:0, borderLeftWidth:0}}}, c.jsx(\"table\", {css:{width:\"100%\", borderCollapse:\"collapse\", borderRadius:2, background:\"#fff\", \"@media (max-width: 700px)\":{\"& th + th + th + th, & td + td + td + td\":{display:\"none\"}}}}, c.jsx(\"thead\", null, c.jsx(\"tr\", null, c.jsx(\"th\", null, c.jsx(H, null, \"Icon\")), c.jsx(\"th\", null, c.jsx(H, null, \"Name\")), c.jsx(\"th\", null, c.jsx(H, \n    null, \"Size\")), c.jsx(\"th\", null, c.jsx(H, null, \"Content Type\")))), c.jsx(\"tbody\", null, h)));\n  }\n  function za(a) {\n    a = a.split(\"/\");\n    return a[a.length - 1];\n  }\n  function Aa(a) {\n    var b = a.uri;\n    return c.jsx(\"div\", {css:{padding:20, textAlign:\"center\"}}, c.jsx(\"img\", {title:za(a.path), src:b}));\n  }\n  function Ba(a) {\n    a = a.highlights.slice(0);\n    var b = a.length && \"\" === a[a.length - 1];\n    b && a.pop();\n    return c.jsx(\"div\", {className:\"code-listing\", css:{overflowX:\"auto\", overflowY:\"hidden\", paddingTop:5, paddingBottom:5}}, c.jsx(\"table\", {css:{border:\"none\", borderCollapse:\"collapse\", borderSpacing:0}}, c.jsx(\"tbody\", null, a.map(function(a, b) {\n      var d = b + 1;\n      return c.jsx(\"tr\", {key:b}, c.jsx(\"td\", {id:\"L\" + d, css:{paddingLeft:10, paddingRight:10, color:\"rgba(27,31,35,.3)\", textAlign:\"right\", verticalAlign:\"top\", width:\"1%\", minWidth:50, userSelect:\"none\"}}, c.jsx(\"span\", null, d)), c.jsx(\"td\", {id:\"LC\" + d, css:{paddingLeft:10, paddingRight:10, color:\"#24292e\", whiteSpace:\"pre\"}}, c.jsx(\"code\", {dangerouslySetInnerHTML:{__html:a}})));\n    }), !b && c.jsx(\"tr\", {key:\"no-newline\"}, c.jsx(\"td\", {css:{paddingLeft:10, paddingRight:10, color:\"rgba(27,31,35,.3)\", textAlign:\"right\", verticalAlign:\"top\", width:\"1%\", minWidth:50, userSelect:\"none\"}}, \"\\\\\"), c.jsx(\"td\", {css:{paddingLeft:10, color:\"rgba(27,31,35,.3)\", userSelect:\"none\"}}, \"No newline at end of file\")))));\n  }\n  function Ca() {\n    return c.jsx(\"div\", {css:{padding:20}}, c.jsx(\"p\", {css:{textAlign:\"center\"}}, \"No preview available.\"));\n  }\n  function ea(a) {\n    var b = a.path, d = a.details, h = t.useContext(T);\n    a = h.packageName;\n    h = h.packageVersion;\n    var f = d.highlights, k = d.uri, r = d.language;\n    d = d.size;\n    var l = b.split(\"/\");\n    l = l[l.length - 1];\n    return c.jsx(\"div\", {css:{border:\"1px solid #dfe2e5\", borderRadius:3, \"@media (max-width: 700px)\":{borderRightWidth:0, borderLeftWidth:0}}}, c.jsx(\"div\", {css:{padding:10, background:\"#f6f8fa\", color:\"#424242\", border:\"1px solid #d1d5da\", borderTopLeftRadius:3, borderTopRightRadius:3, margin:\"-1px -1px 0\", display:\"flex\", flexDirection:\"row\", alignItems:\"center\", justifyContent:\"space-between\", \"@media (max-width: 700px)\":{paddingRight:20, paddingLeft:20}}}, c.jsx(\"span\", null, da(d)), \" \", c.jsx(\"span\", \n    null, r), \" \", c.jsx(\"a\", {title:l, href:\"/\" + a + \"@\" + h + b, css:{display:\"inline-block\", textDecoration:\"none\", padding:\"2px 8px\", fontWeight:600, fontSize:\"0.9rem\", color:\"#24292e\", backgroundColor:\"#eff3f6\", border:\"1px solid rgba(27,31,35,.2)\", borderRadius:3, \":hover\":{backgroundColor:\"#e6ebf1\", borderColor:\"rgba(27,31,35,.35)\"}, \":active\":{backgroundColor:\"#e9ecef\", borderColor:\"rgba(27,31,35,.35)\", boxShadow:\"inset 0 0.15em 0.3em rgba(27,31,35,.15)\"}}}, \"View Raw\")), f ? c.jsx(Ba, {highlights:f}) : \n    k ? c.jsx(Aa, {path:b, uri:k}) : c.jsx(Ca, null));\n  }\n  function fa() {\n    var a = R([\"\\n  .code-listing {\\n    background: #fbfdff;\\n    color: #383a42;\\n  }\\n  .code-comment,\\n  .code-quote {\\n    color: #a0a1a7;\\n    font-style: italic;\\n  }\\n  .code-doctag,\\n  .code-keyword,\\n  .code-link,\\n  .code-formula {\\n    color: #a626a4;\\n  }\\n  .code-section,\\n  .code-name,\\n  .code-selector-tag,\\n  .code-deletion,\\n  .code-subst {\\n    color: #e45649;\\n  }\\n  .code-literal {\\n    color: #0184bb;\\n  }\\n  .code-string,\\n  .code-regexp,\\n  .code-addition,\\n  .code-attribute,\\n  .code-meta-string {\\n    color: #50a14f;\\n  }\\n  .code-built_in,\\n  .code-class .code-title {\\n    color: #c18401;\\n  }\\n  .code-attr,\\n  .code-variable,\\n  .code-template-variable,\\n  .code-type,\\n  .code-selector-class,\\n  .code-selector-attr,\\n  .code-selector-pseudo,\\n  .code-number {\\n    color: #986801;\\n  }\\n  .code-symbol,\\n  .code-bullet,\\n  .code-meta,\\n  .code-selector-id,\\n  .code-title {\\n    color: #4078f2;\\n  }\\n  .code-emphasis {\\n    font-style: italic;\\n  }\\n  .code-strong {\\n    font-weight: bold;\\n  }\\n\"]);\n    fa = function() {\n      return a;\n    };\n    return a;\n  }\n  function ha() {\n    var a = R([\"\\n  html {\\n    box-sizing: border-box;\\n  }\\n  *,\\n  *:before,\\n  *:after {\\n    box-sizing: inherit;\\n  }\\n\\n  html,\\n  body,\\n  #root {\\n    height: 100%;\\n    margin: 0;\\n  }\\n\\n  body {\\n    \", \"\\n    font-size: 16px;\\n    line-height: 1.5;\\n    background: white;\\n    color: black;\\n  }\\n\\n  code {\\n    \", \"\\n  }\\n\\n  th,\\n  td {\\n    padding: 0;\\n  }\\n\\n  select {\\n    font-size: inherit;\\n  }\\n\\n  #root {\\n    display: flex;\\n    flex-direction: column;\\n  }\\n\"]);\n    ha = function() {\n      return a;\n    };\n    return a;\n  }\n  function ia(a) {\n    var b = a.packageName, d = a.packageVersion, h = a.availableVersions;\n    h = void 0 === h ? [] : h;\n    var f = a.filename;\n    a = a.target;\n    var k = [];\n    if (\"/\" === f) {\n      k.push(b);\n    } else {\n      var r = \"/browse/\" + b + \"@\" + d;\n      k.push(c.jsx(\"a\", {href:r + \"/\", css:ja}, b));\n      f = f.replace(/^\\/+/, \"\").replace(/\\/+$/, \"\").split(\"/\");\n      var l = f.pop();\n      f.forEach(function(a) {\n        r += \"/\" + a;\n        k.push(c.jsx(\"a\", {href:r + \"/\", css:ja}, a));\n      });\n      k.push(l);\n    }\n    return c.jsx(ta, {packageName:b, packageVersion:d}, c.jsx(t.Fragment, null, c.jsx(c.Global, {styles:Da}), c.jsx(c.Global, {styles:Ea}), c.jsx(\"div\", {css:{flex:\"1 0 auto\"}}, c.jsx(\"div\", {css:{maxWidth:940, padding:\"0 20px\", margin:\"0 auto\"}}, c.jsx(\"header\", {css:{textAlign:\"center\"}}, c.jsx(\"h1\", {css:{fontSize:\"3rem\", marginTop:\"2rem\"}}, c.jsx(\"a\", {href:\"/\", css:{color:\"#000\", textDecoration:\"none\"}}, \"UNPKG\"))), c.jsx(\"header\", {css:{display:\"flex\", flexDirection:\"row\", alignItems:\"center\", \n    \"@media (max-width: 700px)\":{flexDirection:\"column-reverse\", alignItems:\"flex-start\"}}}, c.jsx(\"h1\", {css:{fontSize:\"1.5rem\", fontWeight:\"normal\", flex:1}}, c.jsx(\"nav\", null, k.map(function(a, b, d) {\n      return c.jsx(\"span\", {key:b}, 0 !== b && c.jsx(\"span\", {css:{paddingLeft:5, paddingRight:5}}, \"/\"), b === d.length - 1 ? c.jsx(\"strong\", null, a) : a);\n    }))), c.jsx(\"p\", {css:{marginLeft:20, \"@media (max-width: 700px)\":{marginLeft:0, marginBottom:0}}}, c.jsx(\"label\", null, \"Version:\", \" \", c.jsx(\"select\", {name:\"version\", defaultValue:d, onChange:function(a) {\n      window.location.href = window.location.href.replace(\"@\" + d, \"@\" + a.target.value);\n    }, css:{appearance:\"none\", cursor:\"pointer\", padding:\"4px 24px 4px 8px\", fontWeight:600, fontSize:\"0.9em\", color:\"#24292e\", border:\"1px solid rgba(27,31,35,.2)\", borderRadius:3, backgroundColor:\"#eff3f6\", backgroundImage:\"url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAAXNSR0IArs4c6QAAARFJREFUKBVjZAACNS39RhBNKrh17WI9o4quoT3Dn78HSNUMUs/CzOTI/O7Vi4dCYpJ3/jP+92BkYGAlyiBGhm8MjIxJt65e3MQM0vDu9YvLYmISILYZELOBxHABRkaGr0yMzF23r12YDFIDNgDEePv65SEhEXENBkYGFSAXuyGMjF8Z/jOsvX3tYiFIDwgwQSgIaaijnvj/P8M5IO8HsjiY/f//D4b//88A1SQhywG9jQr09PS4v/1mPAeUUPzP8B8cJowMjL+Bqu6xMQmaXL164AuyDgwDQJLa2qYSP//9vARkCoMVMzK8YeVkNbh+9uxzMB+JwGoASF5Vx0jz/98/18BqmZi171w9D2EjaaYKEwAEK00XQLdJuwAAAABJRU5ErkJggg==)\", \n    backgroundPosition:\"right 8px center\", backgroundRepeat:\"no-repeat\", backgroundSize:\"auto 25%\", \":hover\":{backgroundColor:\"#e6ebf1\", borderColor:\"rgba(27,31,35,.35)\"}, \":active\":{backgroundColor:\"#e9ecef\", borderColor:\"rgba(27,31,35,.35)\", boxShadow:\"inset 0 0.15em 0.3em rgba(27,31,35,.15)\"}}}, h.map(function(a) {\n      return c.jsx(\"option\", {key:a, value:a}, a);\n    })))))), c.jsx(\"div\", {css:{maxWidth:940, padding:\"0 20px\", margin:\"0 auto\", \"@media (max-width: 700px)\":{padding:0, margin:0}}}, \"directory\" === a.type ? c.jsx(ba, {path:a.path, details:a.details}) : \"file\" === a.type ? c.jsx(ea, {path:a.path, details:a.details}) : null)), c.jsx(\"footer\", {css:{marginTop:\"5rem\", background:\"black\", color:\"#aaa\"}}, c.jsx(\"div\", {css:{maxWidth:940, padding:\"10px 20px\", margin:\"0 auto\", display:\"flex\", flexDirection:\"row\", alignItems:\"center\", justifyContent:\"space-between\"}}, \n    c.jsx(\"p\", null, \"\\u00a9 \", (new Date).getFullYear(), \" UNPKG\"), c.jsx(\"p\", {css:{fontSize:\"1.5rem\"}}, c.jsx(\"a\", {title:\"Twitter\", href:\"https://twitter.com/unpkg\", css:{color:\"#aaa\", display:\"inline-block\", \":hover\":{color:\"white\"}}}, c.jsx(xa, null)), c.jsx(\"a\", {title:\"GitHub\", href:\"https://github.com/mjackson/unpkg\", css:{color:\"#aaa\", display:\"inline-block\", marginLeft:\"1rem\", \":hover\":{color:\"white\"}}}, c.jsx(ya, null)))))));\n  }\n  var M = \"default\" in t ? t[\"default\"] : t;\n  z = z && z.hasOwnProperty(\"default\") ? z[\"default\"] : z;\n  var Fa = \"undefined\" !== typeof globalThis ? globalThis : \"undefined\" !== typeof window ? window : \"undefined\" !== typeof global ? global : \"undefined\" !== typeof self ? self : {}, m = D(function(a, b) {\n    function d(a) {\n      if (\"object\" === typeof a && null !== a) {\n        var b = a.$$typeof;\n        switch(b) {\n          case f:\n            switch(a = a.type, a) {\n              case g:\n              case e:\n              case r:\n              case m:\n              case l:\n              case u:\n                return a;\n              default:\n                switch(a = a && a.$$typeof, a) {\n                  case p:\n                  case n:\n                  case q:\n                    return a;\n                  default:\n                    return b;\n                }\n            }case w:\n          case v:\n          case k:\n            return b;\n        }\n      }\n    }\n    function c(a) {\n      return d(a) === e;\n    }\n    Object.defineProperty(b, \"__esModule\", {value:!0});\n    var f = (a = \"function\" === typeof Symbol && Symbol.for) ? Symbol.for(\"react.element\") : 60103, k = a ? Symbol.for(\"react.portal\") : 60106, r = a ? Symbol.for(\"react.fragment\") : 60107, l = a ? Symbol.for(\"react.strict_mode\") : 60108, m = a ? Symbol.for(\"react.profiler\") : 60114, q = a ? Symbol.for(\"react.provider\") : 60109, p = a ? Symbol.for(\"react.context\") : 60110, g = a ? Symbol.for(\"react.async_mode\") : 60111, e = a ? Symbol.for(\"react.concurrent_mode\") : 60111, n = a ? Symbol.for(\"react.forward_ref\") : \n    60112, u = a ? Symbol.for(\"react.suspense\") : 60113, v = a ? Symbol.for(\"react.memo\") : 60115, w = a ? Symbol.for(\"react.lazy\") : 60116;\n    b.typeOf = d;\n    b.AsyncMode = g;\n    b.ConcurrentMode = e;\n    b.ContextConsumer = p;\n    b.ContextProvider = q;\n    b.Element = f;\n    b.ForwardRef = n;\n    b.Fragment = r;\n    b.Lazy = w;\n    b.Memo = v;\n    b.Portal = k;\n    b.Profiler = m;\n    b.StrictMode = l;\n    b.Suspense = u;\n    b.isValidElementType = function(a) {\n      return \"string\" === typeof a || \"function\" === typeof a || a === r || a === e || a === m || a === l || a === u || \"object\" === typeof a && null !== a && (a.$$typeof === w || a.$$typeof === v || a.$$typeof === q || a.$$typeof === p || a.$$typeof === n);\n    };\n    b.isAsyncMode = function(a) {\n      return c(a) || d(a) === g;\n    };\n    b.isConcurrentMode = c;\n    b.isContextConsumer = function(a) {\n      return d(a) === p;\n    };\n    b.isContextProvider = function(a) {\n      return d(a) === q;\n    };\n    b.isElement = function(a) {\n      return \"object\" === typeof a && null !== a && a.$$typeof === f;\n    };\n    b.isForwardRef = function(a) {\n      return d(a) === n;\n    };\n    b.isFragment = function(a) {\n      return d(a) === r;\n    };\n    b.isLazy = function(a) {\n      return d(a) === w;\n    };\n    b.isMemo = function(a) {\n      return d(a) === v;\n    };\n    b.isPortal = function(a) {\n      return d(a) === k;\n    };\n    b.isProfiler = function(a) {\n      return d(a) === m;\n    };\n    b.isStrictMode = function(a) {\n      return d(a) === l;\n    };\n    b.isSuspense = function(a) {\n      return d(a) === u;\n    };\n  });\n  S(m);\n  var la = D(function(a, b) {\n    (function() {\n      function a(a) {\n        if (\"object\" === typeof a && null !== a) {\n          var b = a.$$typeof;\n          switch(b) {\n            case k:\n              switch(a = a.type, a) {\n                case e:\n                case n:\n                case l:\n                case q:\n                case m:\n                case v:\n                  return a;\n                default:\n                  switch(a = a && a.$$typeof, a) {\n                    case g:\n                    case u:\n                    case p:\n                      return a;\n                    default:\n                      return b;\n                  }\n              }case I:\n            case w:\n            case r:\n              return b;\n          }\n        }\n      }\n      function c(b) {\n        return a(b) === n;\n      }\n      Object.defineProperty(b, \"__esModule\", {value:!0});\n      var f = \"function\" === typeof Symbol && Symbol.for, k = f ? Symbol.for(\"react.element\") : 60103, r = f ? Symbol.for(\"react.portal\") : 60106, l = f ? Symbol.for(\"react.fragment\") : 60107, m = f ? Symbol.for(\"react.strict_mode\") : 60108, q = f ? Symbol.for(\"react.profiler\") : 60114, p = f ? Symbol.for(\"react.provider\") : 60109, g = f ? Symbol.for(\"react.context\") : 60110, e = f ? Symbol.for(\"react.async_mode\") : 60111, n = f ? Symbol.for(\"react.concurrent_mode\") : 60111, u = f ? Symbol.for(\"react.forward_ref\") : \n      60112, v = f ? Symbol.for(\"react.suspense\") : 60113, w = f ? Symbol.for(\"react.memo\") : 60115, I = f ? Symbol.for(\"react.lazy\") : 60116;\n      f = function() {\n      };\n      var Ga = function(a) {\n        for (var b = arguments.length, e = Array(1 < b ? b - 1 : 0), n = 1; n < b; n++) {\n          e[n - 1] = arguments[n];\n        }\n        var c = 0;\n        b = \"Warning: \" + a.replace(/%s/g, function() {\n          return e[c++];\n        });\n        \"undefined\" !== typeof console && console.warn(b);\n        try {\n          throw Error(b);\n        } catch (Ra) {\n        }\n      }, Ha = f = function(a, b) {\n        if (void 0 === b) {\n          throw Error(\"`lowPriorityWarning(condition, format, ...args)` requires a warning message argument\");\n        }\n        if (!a) {\n          for (var e = arguments.length, n = Array(2 < e ? e - 2 : 0), c = 2; c < e; c++) {\n            n[c - 2] = arguments[c];\n          }\n          Ga.apply(void 0, [b].concat(n));\n        }\n      }, ka = !1;\n      b.typeOf = a;\n      b.AsyncMode = e;\n      b.ConcurrentMode = n;\n      b.ContextConsumer = g;\n      b.ContextProvider = p;\n      b.Element = k;\n      b.ForwardRef = u;\n      b.Fragment = l;\n      b.Lazy = I;\n      b.Memo = w;\n      b.Portal = r;\n      b.Profiler = q;\n      b.StrictMode = m;\n      b.Suspense = v;\n      b.isValidElementType = function(a) {\n        return \"string\" === typeof a || \"function\" === typeof a || a === l || a === n || a === q || a === m || a === v || \"object\" === typeof a && null !== a && (a.$$typeof === I || a.$$typeof === w || a.$$typeof === p || a.$$typeof === g || a.$$typeof === u);\n      };\n      b.isAsyncMode = function(b) {\n        ka || (ka = !0, Ha(!1, \"The ReactIs.isAsyncMode() alias has been deprecated, and will be removed in React 17+. Update your code to use ReactIs.isConcurrentMode() instead. It has the exact same API.\"));\n        return c(b) || a(b) === e;\n      };\n      b.isConcurrentMode = c;\n      b.isContextConsumer = function(b) {\n        return a(b) === g;\n      };\n      b.isContextProvider = function(b) {\n        return a(b) === p;\n      };\n      b.isElement = function(a) {\n        return \"object\" === typeof a && null !== a && a.$$typeof === k;\n      };\n      b.isForwardRef = function(b) {\n        return a(b) === u;\n      };\n      b.isFragment = function(b) {\n        return a(b) === l;\n      };\n      b.isLazy = function(b) {\n        return a(b) === I;\n      };\n      b.isMemo = function(b) {\n        return a(b) === w;\n      };\n      b.isPortal = function(b) {\n        return a(b) === r;\n      };\n      b.isProfiler = function(b) {\n        return a(b) === q;\n      };\n      b.isStrictMode = function(b) {\n        return a(b) === m;\n      };\n      b.isSuspense = function(b) {\n        return a(b) === v;\n      };\n    })();\n  });\n  S(la);\n  var ma = D(function(a) {\n    a.exports = la;\n  }), na = Object.getOwnPropertySymbols, Ia = Object.prototype.hasOwnProperty, Ja = Object.prototype.propertyIsEnumerable, Ka = function() {\n    try {\n      if (!Object.assign) {\n        return !1;\n      }\n      var a = new String(\"abc\");\n      a[5] = \"de\";\n      if (\"5\" === Object.getOwnPropertyNames(a)[0]) {\n        return !1;\n      }\n      var b = {};\n      for (a = 0; 10 > a; a++) {\n        b[\"_\" + String.fromCharCode(a)] = a;\n      }\n      if (\"0123456789\" !== Object.getOwnPropertyNames(b).map(function(a) {\n        return b[a];\n      }).join(\"\")) {\n        return !1;\n      }\n      var c = {};\n      \"abcdefghijklmnopqrst\".split(\"\").forEach(function(a) {\n        c[a] = a;\n      });\n      return \"abcdefghijklmnopqrst\" !== Object.keys(Object.assign({}, c)).join(\"\") ? !1 : !0;\n    } catch (h) {\n      return !1;\n    }\n  }() ? Object.assign : function(a, b) {\n    if (null === a || void 0 === a) {\n      throw new TypeError(\"Object.assign cannot be called with null or undefined\");\n    }\n    var c = Object(a);\n    for (var h, f = 1; f < arguments.length; f++) {\n      var k = Object(arguments[f]);\n      for (var r in k) {\n        Ia.call(k, r) && (c[r] = k[r]);\n      }\n      if (na) {\n        h = na(k);\n        for (var l = 0; l < h.length; l++) {\n          Ja.call(k, h[l]) && (c[h[l]] = k[h[l]]);\n        }\n      }\n    }\n    return c;\n  }, K = function() {\n  }, L = {}, sa = Function.call.bind(Object.prototype.hasOwnProperty);\n  K = function(a) {\n    a = \"Warning: \" + a;\n    \"undefined\" !== typeof console && console.error(a);\n    try {\n      throw Error(a);\n    } catch (b) {\n    }\n  };\n  J.resetWarningCache = function() {\n    L = {};\n  };\n  var La = Function.call.bind(Object.prototype.hasOwnProperty), C = function() {\n  };\n  C = function(a) {\n    a = \"Warning: \" + a;\n    \"undefined\" !== typeof console && console.error(a);\n    try {\n      throw Error(a);\n    } catch (b) {\n    }\n  };\n  var Ma = function(a, b) {\n    function c(a, b) {\n      return a === b ? 0 !== a || 1 / a === 1 / b : a !== a && b !== b;\n    }\n    function h(a) {\n      this.message = a;\n      this.stack = \"\";\n    }\n    function f(a) {\n      function e(e, n, g, u, f, k, v) {\n        u = u || \"<<anonymous>>\";\n        k = k || g;\n        if (\"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\" !== v) {\n          if (b) {\n            throw e = Error(\"Calling PropTypes validators directly is not supported by the `prop-types` package. Use `PropTypes.checkPropTypes()` to call them. Read more at http://fb.me/use-check-prop-types\"), e.name = \"Invariant Violation\", e;\n          }\n          \"undefined\" !== typeof console && (v = u + \":\" + g, !c[v] && 3 > d && (C(\"You are manually calling a React.PropTypes validation function for the `\" + k + \"` prop on `\" + u + \"`. This is deprecated and will throw in the standalone `prop-types` package. You may be seeing this warning due to a third-party PropTypes library. See https://fb.me/react-warning-dont-call-proptypes for details.\"), c[v] = !0, d++));\n        }\n        return null == n[g] ? e ? null === n[g] ? new h(\"The \" + f + \" `\" + k + \"` is marked as required \" + (\"in `\" + u + \"`, but its value is `null`.\")) : new h(\"The \" + f + \" `\" + k + \"` is marked as required in \" + (\"`\" + u + \"`, but its value is `undefined`.\")) : null : a(n, g, u, f, k);\n      }\n      var c = {}, d = 0, g = e.bind(null, !1);\n      g.isRequired = e.bind(null, !0);\n      return g;\n    }\n    function k(a) {\n      return f(function(b, e, c, d, g, f) {\n        b = b[e];\n        return l(b) !== a ? (b = m(b), new h(\"Invalid \" + d + \" `\" + g + \"` of type \" + (\"`\" + b + \"` supplied to `\" + c + \"`, expected \") + (\"`\" + a + \"`.\"))) : null;\n      });\n    }\n    function r(b) {\n      switch(typeof b) {\n        case \"number\":\n        case \"string\":\n        case \"undefined\":\n          return !0;\n        case \"boolean\":\n          return !b;\n        case \"object\":\n          if (Array.isArray(b)) {\n            return b.every(r);\n          }\n          if (null === b || a(b)) {\n            return !0;\n          }\n          var e = b && (p && b[p] || b[\"@@iterator\"]);\n          var c = \"function\" === typeof e ? e : void 0;\n          if (c) {\n            if (e = c.call(b), c !== b.entries) {\n              for (; !(b = e.next()).done;) {\n                if (!r(b.value)) {\n                  return !1;\n                }\n              }\n            } else {\n              for (; !(b = e.next()).done;) {\n                if ((b = b.value) && !r(b[1])) {\n                  return !1;\n                }\n              }\n            }\n          } else {\n            return !1;\n          }\n          return !0;\n        default:\n          return !1;\n      }\n    }\n    function l(a) {\n      var b = typeof a;\n      return Array.isArray(a) ? \"array\" : a instanceof RegExp ? \"object\" : \"symbol\" === b || a && (\"Symbol\" === a[\"@@toStringTag\"] || \"function\" === typeof Symbol && a instanceof Symbol) ? \"symbol\" : b;\n    }\n    function m(a) {\n      if (\"undefined\" === typeof a || null === a) {\n        return \"\" + a;\n      }\n      var b = l(a);\n      if (\"object\" === b) {\n        if (a instanceof Date) {\n          return \"date\";\n        }\n        if (a instanceof RegExp) {\n          return \"regexp\";\n        }\n      }\n      return b;\n    }\n    function q(a) {\n      a = m(a);\n      switch(a) {\n        case \"array\":\n        case \"object\":\n          return \"an \" + a;\n        case \"boolean\":\n        case \"date\":\n        case \"regexp\":\n          return \"a \" + a;\n        default:\n          return a;\n      }\n    }\n    var p = \"function\" === typeof Symbol && Symbol.iterator, g = {array:k(\"array\"), bool:k(\"boolean\"), func:k(\"function\"), number:k(\"number\"), object:k(\"object\"), string:k(\"string\"), symbol:k(\"symbol\"), any:f(E), arrayOf:function(a) {\n      return f(function(b, c, e, d, g) {\n        if (\"function\" !== typeof a) {\n          return new h(\"Property `\" + g + \"` of component `\" + e + \"` has invalid PropType notation inside arrayOf.\");\n        }\n        b = b[c];\n        if (!Array.isArray(b)) {\n          return b = l(b), new h(\"Invalid \" + d + \" `\" + g + \"` of type \" + (\"`\" + b + \"` supplied to `\" + e + \"`, expected an array.\"));\n        }\n        for (c = 0; c < b.length; c++) {\n          var n = a(b, c, e, d, g + \"[\" + c + \"]\", \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\");\n          if (n instanceof Error) {\n            return n;\n          }\n        }\n        return null;\n      });\n    }, element:function() {\n      return f(function(b, c, d, g, f) {\n        b = b[c];\n        return a(b) ? null : (b = l(b), new h(\"Invalid \" + g + \" `\" + f + \"` of type \" + (\"`\" + b + \"` supplied to `\" + d + \"`, expected a single ReactElement.\")));\n      });\n    }(), elementType:function() {\n      return f(function(a, b, c, d, g) {\n        a = a[b];\n        return ma.isValidElementType(a) ? null : (a = l(a), new h(\"Invalid \" + d + \" `\" + g + \"` of type \" + (\"`\" + a + \"` supplied to `\" + c + \"`, expected a single ReactElement type.\")));\n      });\n    }(), instanceOf:function(a) {\n      return f(function(b, c, e, d, g) {\n        if (!(b[c] instanceof a)) {\n          var n = a.name || \"<<anonymous>>\";\n          b = b[c];\n          b = b.constructor && b.constructor.name ? b.constructor.name : \"<<anonymous>>\";\n          return new h(\"Invalid \" + d + \" `\" + g + \"` of type \" + (\"`\" + b + \"` supplied to `\" + e + \"`, expected \") + (\"instance of `\" + n + \"`.\"));\n        }\n        return null;\n      });\n    }, node:function() {\n      return f(function(a, b, c, d, g) {\n        return r(a[b]) ? null : new h(\"Invalid \" + d + \" `\" + g + \"` supplied to \" + (\"`\" + c + \"`, expected a ReactNode.\"));\n      });\n    }(), objectOf:function(a) {\n      return f(function(b, c, e, d, g) {\n        if (\"function\" !== typeof a) {\n          return new h(\"Property `\" + g + \"` of component `\" + e + \"` has invalid PropType notation inside objectOf.\");\n        }\n        b = b[c];\n        c = l(b);\n        if (\"object\" !== c) {\n          return new h(\"Invalid \" + d + \" `\" + g + \"` of type \" + (\"`\" + c + \"` supplied to `\" + e + \"`, expected an object.\"));\n        }\n        for (var n in b) {\n          if (La(b, n) && (c = a(b, n, e, d, g + \".\" + n, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\"), c instanceof Error)) {\n            return c;\n          }\n        }\n        return null;\n      });\n    }, oneOf:function(a) {\n      return Array.isArray(a) ? f(function(b, e, g, d, f) {\n        b = b[e];\n        for (e = 0; e < a.length; e++) {\n          if (c(b, a[e])) {\n            return null;\n          }\n        }\n        e = JSON.stringify(a, function(a, b) {\n          return \"symbol\" === m(b) ? String(b) : b;\n        });\n        return new h(\"Invalid \" + d + \" `\" + f + \"` of value `\" + String(b) + \"` \" + (\"supplied to `\" + g + \"`, expected one of \" + e + \".\"));\n      }) : (1 < arguments.length ? C(\"Invalid arguments supplied to oneOf, expected an array, got \" + arguments.length + \" arguments. A common mistake is to write oneOf(x, y, z) instead of oneOf([x, y, z]).\") : C(\"Invalid argument supplied to oneOf, expected an array.\"), E);\n    }, oneOfType:function(a) {\n      if (!Array.isArray(a)) {\n        return C(\"Invalid argument supplied to oneOfType, expected an instance of array.\"), E;\n      }\n      for (var b = 0; b < a.length; b++) {\n        var c = a[b];\n        if (\"function\" !== typeof c) {\n          return C(\"Invalid argument supplied to oneOfType. Expected an array of check functions, but received \" + q(c) + \" at index \" + b + \".\"), E;\n        }\n      }\n      return f(function(b, c, e, g, d) {\n        for (var f = 0; f < a.length; f++) {\n          if (null == (0,a[f])(b, c, e, g, d, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\")) {\n            return null;\n          }\n        }\n        return new h(\"Invalid \" + g + \" `\" + d + \"` supplied to \" + (\"`\" + e + \"`.\"));\n      });\n    }, shape:function(a) {\n      return f(function(b, c, e, g, d) {\n        b = b[c];\n        c = l(b);\n        if (\"object\" !== c) {\n          return new h(\"Invalid \" + g + \" `\" + d + \"` of type `\" + c + \"` \" + (\"supplied to `\" + e + \"`, expected `object`.\"));\n        }\n        for (var f in a) {\n          if (c = a[f]) {\n            if (c = c(b, f, e, g, d + \".\" + f, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\")) {\n              return c;\n            }\n          }\n        }\n        return null;\n      });\n    }, exact:function(a) {\n      return f(function(b, c, g, d, e) {\n        var f = b[c], n = l(f);\n        if (\"object\" !== n) {\n          return new h(\"Invalid \" + d + \" `\" + e + \"` of type `\" + n + \"` \" + (\"supplied to `\" + g + \"`, expected `object`.\"));\n        }\n        n = Ka({}, b[c], a);\n        for (var k in n) {\n          n = a[k];\n          if (!n) {\n            return new h(\"Invalid \" + d + \" `\" + e + \"` key `\" + k + \"` supplied to `\" + g + \"`.\\nBad object: \" + JSON.stringify(b[c], null, \"  \") + \"\\nValid keys: \" + JSON.stringify(Object.keys(a), null, \"  \"));\n          }\n          if (n = n(f, k, g, d, e + \".\" + k, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\")) {\n            return n;\n          }\n        }\n        return null;\n      });\n    }};\n    h.prototype = Error.prototype;\n    g.checkPropTypes = J;\n    g.resetWarningCache = J.resetWarningCache;\n    return g.PropTypes = g;\n  };\n  m = D(function(a) {\n    a.exports = Ma(ma.isElement, !0);\n  });\n  var T = t.createContext(), Na = Object.assign || function(a) {\n    for (var b = 1; b < arguments.length; b++) {\n      var c = arguments[b], h;\n      for (h in c) {\n        Object.prototype.hasOwnProperty.call(c, h) && (a[h] = c[h]);\n      }\n    }\n    return a;\n  }, Oa = {border:0, clip:\"rect(0 0 0 0)\", height:\"1px\", width:\"1px\", margin:\"-1px\", padding:0, overflow:\"hidden\", position:\"absolute\"}, H = function(a) {\n    return M.createElement(\"div\", Na({style:Oa}, a));\n  }, oa = D(function(a) {\n    (function(b, c) {\n      a.exports = c();\n    })(Fa, function() {\n      function a(a) {\n        if (!a) {\n          return !0;\n        }\n        if (!f(a) || 0 !== a.length) {\n          for (var b in a) {\n            if (q.call(a, b)) {\n              return !1;\n            }\n          }\n        }\n        return !0;\n      }\n      function c(a) {\n        return \"number\" === typeof a || \"[object Number]\" === t.call(a);\n      }\n      function h(a) {\n        return \"string\" === typeof a || \"[object String]\" === t.call(a);\n      }\n      function f(a) {\n        return \"object\" === typeof a && \"number\" === typeof a.length && \"[object Array]\" === t.call(a);\n      }\n      function k(a) {\n        var b = parseInt(a);\n        return b.toString() === a ? b : a;\n      }\n      function m(b, e, d, f) {\n        c(e) && (e = [e]);\n        if (a(e)) {\n          return b;\n        }\n        if (h(e)) {\n          return m(b, e.split(\".\"), d, f);\n        }\n        var g = k(e[0]);\n        if (1 === e.length) {\n          return e = b[g], void 0 !== e && f || (b[g] = d), e;\n        }\n        void 0 === b[g] && (c(g) ? b[g] = [] : b[g] = {});\n        return m(b[g], e.slice(1), d, f);\n      }\n      function l(b, e) {\n        c(e) && (e = [e]);\n        if (!a(b)) {\n          if (a(e)) {\n            return b;\n          }\n          if (h(e)) {\n            return l(b, e.split(\".\"));\n          }\n          var d = k(e[0]), g = b[d];\n          if (1 === e.length) {\n            void 0 !== g && (f(b) ? b.splice(d, 1) : delete b[d]);\n          } else {\n            if (void 0 !== b[d]) {\n              return l(b[d], e.slice(1));\n            }\n          }\n          return b;\n        }\n      }\n      var t = Object.prototype.toString, q = Object.prototype.hasOwnProperty, p = {ensureExists:function(a, b, c) {\n        return m(a, b, c, !0);\n      }, set:function(a, b, c, d) {\n        return m(a, b, c, d);\n      }, insert:function(a, b, c, d) {\n        var e = p.get(a, b);\n        d = ~~d;\n        f(e) || (e = [], p.set(a, b, e));\n        e.splice(d, 0, c);\n      }, empty:function(b, d) {\n        if (a(d)) {\n          return b;\n        }\n        if (!a(b)) {\n          var e, g;\n          if (!(e = p.get(b, d))) {\n            return b;\n          }\n          if (h(e)) {\n            return p.set(b, d, \"\");\n          }\n          if (\"boolean\" === typeof e || \"[object Boolean]\" === t.call(e)) {\n            return p.set(b, d, !1);\n          }\n          if (c(e)) {\n            return p.set(b, d, 0);\n          }\n          if (f(e)) {\n            e.length = 0;\n          } else {\n            if (\"object\" === typeof e && \"[object Object]\" === t.call(e)) {\n              for (g in e) {\n                q.call(e, g) && delete e[g];\n              }\n            } else {\n              return p.set(b, d, null);\n            }\n          }\n        }\n      }, push:function(a, b) {\n        var c = p.get(a, b);\n        f(c) || (c = [], p.set(a, b, c));\n        c.push.apply(c, Array.prototype.slice.call(arguments, 2));\n      }, coalesce:function(a, b, c) {\n        for (var d, e = 0, f = b.length; e < f; e++) {\n          if (void 0 !== (d = p.get(a, b[e]))) {\n            return d;\n          }\n        }\n        return c;\n      }, get:function(b, d, f) {\n        c(d) && (d = [d]);\n        if (a(d)) {\n          return b;\n        }\n        if (a(b)) {\n          return f;\n        }\n        if (h(d)) {\n          return p.get(b, d.split(\".\"), f);\n        }\n        var e = k(d[0]);\n        return 1 === d.length ? void 0 === b[e] ? f : b[e] : p.get(b[e], d.slice(1), f);\n      }, del:function(a, b) {\n        return l(a, b);\n      }};\n      return p;\n    });\n  });\n  var pa = function(a) {\n    return function(b) {\n      return typeof b === a;\n    };\n  };\n  var Pa = function(a, b) {\n    var c = 1, h = b || function(a, b) {\n      return b;\n    };\n    \"-\" === a[0] && (c = -1, a = a.substr(1));\n    return function(b, d) {\n      var f;\n      b = h(a, oa.get(b, a));\n      d = h(a, oa.get(d, a));\n      b < d && (f = -1);\n      b > d && (f = 1);\n      b === d && (f = 0);\n      return f * c;\n    };\n  };\n  var ca = function() {\n    var a = Array.prototype.slice.call(arguments), b = a.filter(pa(\"string\")), c = a.filter(pa(\"function\"))[0];\n    return function(a, d) {\n      for (var f = b.length, h = 0, l = 0; 0 === h && l < f;) {\n        h = Pa(b[l], c)(a, d), l++;\n      }\n      return h;\n    };\n  };\n  let qa = \"B kB MB GB TB PB EB ZB YB\".split(\" \"), ra = (a, b) => {\n    let c = a;\n    \"string\" === typeof b ? c = a.toLocaleString(b) : !0 === b && (c = a.toLocaleString());\n    return c;\n  };\n  var da = (a, b) => {\n    if (!Number.isFinite(a)) {\n      throw new TypeError(`Expected a finite number, got ${typeof a}: ${a}`);\n    }\n    b = Object.assign({}, b);\n    if (b.signed && 0 === a) {\n      return \" 0 B\";\n    }\n    var c = 0 > a;\n    let h = c ? \"-\" : b.signed ? \"+\" : \"\";\n    c && (a = -a);\n    if (1 > a) {\n      return a = ra(a, b.locale), h + a + \" B\";\n    }\n    c = Math.min(Math.floor(Math.log10(a) / 3), qa.length - 1);\n    a = Number((a / Math.pow(1000, c)).toPrecision(3));\n    a = ra(a, b.locale);\n    return h + a + \" \" + qa[c];\n  }, W = {color:void 0, size:void 0, className:void 0, style:void 0, attr:void 0}, V = t.createContext && t.createContext(W), y = function() {\n    y = Object.assign || function(a) {\n      for (var b, c = 1, h = arguments.length; c < h; c++) {\n        b = arguments[c];\n        for (var f in b) {\n          Object.prototype.hasOwnProperty.call(b, f) && (a[f] = b[f]);\n        }\n      }\n      return a;\n    };\n    return y.apply(this, arguments);\n  }, X = function(a) {\n    return F({tag:\"svg\", attr:{viewBox:\"0 0 14 16\"}, child:[{tag:\"path\", attr:{fillRule:\"evenodd\", d:\"M13 4H7V3c0-.66-.31-1-1-1H1c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1V5c0-.55-.45-1-1-1zM6 4H1V3h5v1z\"}}]})(a);\n  };\n  X.displayName = \"GoFileDirectory\";\n  var Y = function(a) {\n    return F({tag:\"svg\", attr:{viewBox:\"0 0 12 16\"}, child:[{tag:\"path\", attr:{fillRule:\"evenodd\", d:\"M6 5H2V4h4v1zM2 8h7V7H2v1zm0 2h7V9H2v1zm0 2h7v-1H2v1zm10-7.5V14c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V2c0-.55.45-1 1-1h7.5L12 4.5zM11 5L8 2H1v12h10V5z\"}}]})(a);\n  };\n  Y.displayName = \"GoFile\";\n  var aa = function(a) {\n    return F({tag:\"svg\", attr:{viewBox:\"0 0 496 512\"}, child:[{tag:\"path\", attr:{d:\"M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8zM97.2 352.9c-1.3 1-1 3.3.7 5.2 1.6 1.6 3.9 2.3 5.2 1 1.3-1 1-3.3-.7-5.2-1.6-1.6-3.9-2.3-5.2-1zm-10.8-8.1c-.7 1.3.3 2.9 2.3 3.9 1.6 1 3.6.7 4.3-.7.7-1.3-.3-2.9-2.3-3.9-2-.6-3.6-.3-4.3.7zm32.4 35.6c-1.6 1.3-1 4.3 1.3 6.2 2.3 2.3 5.2 2.6 6.5 1 1.3-1.3.7-4.3-1.3-6.2-2.2-2.3-5.2-2.6-6.5-1zm-11.4-14.7c-1.6 1-1.6 3.6 0 5.9 1.6 2.3 4.3 3.3 5.6 2.3 1.6-1.3 1.6-3.9 0-6.2-1.4-2.3-4-3.3-5.6-2z\"}}]})(a);\n  };\n  aa.displayName = \"FaGithub\";\n  var Z = function(a) {\n    return F({tag:\"svg\", attr:{viewBox:\"0 0 512 512\"}, child:[{tag:\"path\", attr:{d:\"M459.37 151.716c.325 4.548.325 9.097.325 13.645 0 138.72-105.583 298.558-298.558 298.558-59.452 0-114.68-17.219-161.137-47.106 8.447.974 16.568 1.299 25.34 1.299 49.055 0 94.213-16.568 130.274-44.832-46.132-.975-84.792-31.188-98.112-72.772 6.498.974 12.995 1.624 19.818 1.624 9.421 0 18.843-1.3 27.614-3.573-48.081-9.747-84.143-51.98-84.143-102.985v-1.299c13.969 7.797 30.214 12.67 47.431 13.319-28.264-18.843-46.781-51.005-46.781-87.391 0-19.492 5.197-37.36 14.294-52.954 51.655 63.675 129.3 105.258 216.365 109.807-1.624-7.797-2.599-15.918-2.599-24.04 0-57.828 46.782-104.934 104.934-104.934 30.213 0 57.502 12.67 76.67 33.137 23.715-4.548 46.456-13.32 66.599-25.34-7.798 24.366-24.366 44.833-46.132 57.827 21.117-2.273 41.584-8.122 60.426-16.243-14.292 20.791-32.161 39.308-52.628 54.253z\"}}]})(a);\n  };\n  Z.displayName = \"FaTwitter\";\n  var O = {color:\"#0076ff\", textDecoration:\"none\", \":hover\":{textDecoration:\"underline\"}}, x = {paddingTop:6, paddingRight:3, paddingBottom:6, paddingLeft:3, borderTop:\"1px solid #eaecef\"}, N = A({}, x, {color:\"#424242\", width:17, paddingRight:2, paddingLeft:10, \"@media (max-width: 700px)\":{paddingLeft:20}}), P = A({}, x, {textAlign:\"right\", paddingRight:10, \"@media (max-width: 700px)\":{paddingRight:20}});\n  ba.propTypes = {path:m.string.isRequired, details:m.objectOf(m.shape({path:m.string.isRequired, type:m.oneOf([\"directory\", \"file\"]).isRequired, contentType:m.string, integrity:m.string, size:m.number})).isRequired};\n  ea.propTypes = {path:m.string.isRequired, details:m.shape({contentType:m.string.isRequired, highlights:m.arrayOf(m.string), uri:m.string, integrity:m.string.isRequired, language:m.string.isRequired, size:m.number.isRequired}).isRequired};\n  var Da = c.css(ha(), '\\nfont-family: -apple-system,\\n  BlinkMacSystemFont,\\n  \"Segoe UI\",\\n  \"Roboto\",\\n  \"Oxygen\",\\n  \"Ubuntu\",\\n  \"Cantarell\",\\n  \"Fira Sans\",\\n  \"Droid Sans\",\\n  \"Helvetica Neue\",\\n  sans-serif;\\n', \"\\nfont-family: Menlo,\\n  Monaco,\\n  Lucida Console,\\n  Liberation Mono,\\n  DejaVu Sans Mono,\\n  Bitstream Vera Sans Mono,\\n  Courier New,\\n  monospace;\\n\"), Ea = c.css(fa()), ja = {color:\"#0076ff\", textDecoration:\"none\", \":hover\":{textDecoration:\"underline\"}}, Qa = m.shape({path:m.string.isRequired, \n  type:m.oneOf([\"directory\", \"file\"]).isRequired, details:m.object.isRequired});\n  ia.propTypes = {packageName:m.string.isRequired, packageVersion:m.string.isRequired, availableVersions:m.arrayOf(m.string), filename:m.string.isRequired, target:Qa.isRequired};\n  z.hydrate(M.createElement(ia, window.__DATA__ || {}), document.getElementById(\"root\"));\n})(React, ReactDOM, emotionCore);\n\n"}]},{"main":[{"format":"iife","globalImports":["react","react-dom","@emotion/core"],"url":"/_client/main-1241dd6e.js","code":"'use strict';\n(function(u, z, c) {\n  function C() {\n    C = Object.assign || function(a) {\n      for (var b = 1; b < arguments.length; b++) {\n        var d = arguments[b], c;\n        for (c in d) {\n          Object.prototype.hasOwnProperty.call(d, c) && (a[c] = d[c]);\n        }\n      }\n      return a;\n    };\n    return C.apply(this, arguments);\n  }\n  function qa(a, b) {\n    b || (b = a.slice(0));\n    a.raw = b;\n    return a;\n  }\n  function P(a) {\n    return a && a.__esModule && Object.prototype.hasOwnProperty.call(a, \"default\") ? a[\"default\"] : a;\n  }\n  function D(a, b) {\n    return b = {exports:{}}, a(b, b.exports), b.exports;\n  }\n  function I(a, b, d, c, e) {\n    for (var f in a) {\n      if (ra(a, f)) {\n        try {\n          if (\"function\" !== typeof a[f]) {\n            var g = Error((c || \"React class\") + \": \" + d + \" type `\" + f + \"` is invalid; it must be a function, usually from the `prop-types` package, but received `\" + typeof a[f] + \"`.\");\n            g.name = \"Invariant Violation\";\n            throw g;\n          }\n          var l = a[f](b, f, c, d, null, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\");\n        } catch (k) {\n          l = k;\n        }\n        !l || l instanceof Error || J((c || \"React class\") + \": type specification of \" + d + \" `\" + f + \"` is invalid; the type checker function must return `null` or an `Error` but returned a \" + typeof l + \". You may have forgotten to pass an argument to the type checker creator (arrayOf, instanceOf, objectOf, oneOf, oneOfType, and shape all require an argument).\");\n        if (l instanceof Error && !(l.message in K)) {\n          K[l.message] = !0;\n          var A = e ? e() : \"\";\n          J(\"Failed \" + d + \" type: \" + l.message + (null != A ? A : \"\"));\n        }\n      }\n    }\n  }\n  function E() {\n    return null;\n  }\n  function sa(a, b) {\n    if (null === b) {\n      return null;\n    }\n    var d;\n    if (0 === a.length) {\n      return a = new Date(0), a.setUTCFullYear(b), a;\n    }\n    if (d = ta.exec(a)) {\n      a = new Date(0);\n      var c = parseInt(d[1], 10) - 1;\n      a.setUTCFullYear(b, c);\n      return a;\n    }\n    return (d = ua.exec(a)) ? (a = new Date(0), d = parseInt(d[1], 10), a.setUTCFullYear(b, 0, d), a) : (d = va.exec(a)) ? (a = new Date(0), c = parseInt(d[1], 10) - 1, d = parseInt(d[2], 10), a.setUTCFullYear(b, c, d), a) : (d = wa.exec(a)) ? (a = parseInt(d[1], 10) - 1, Q(b, a)) : (d = xa.exec(a)) ? (a = parseInt(d[1], 10) - 1, d = parseInt(d[2], 10) - 1, Q(b, a, d)) : null;\n  }\n  function ya(a) {\n    var b;\n    if (b = za.exec(a)) {\n      return a = parseFloat(b[1].replace(\",\", \".\")), a % 24 * 3600000;\n    }\n    if (b = Aa.exec(a)) {\n      a = parseInt(b[1], 10);\n      var d = parseFloat(b[2].replace(\",\", \".\"));\n      return a % 24 * 3600000 + 60000 * d;\n    }\n    return (b = Ba.exec(a)) ? (a = parseInt(b[1], 10), d = parseInt(b[2], 10), b = parseFloat(b[3].replace(\",\", \".\")), a % 24 * 3600000 + 60000 * d + 1000 * b) : null;\n  }\n  function Ca(a) {\n    var b;\n    return (b = Da.exec(a)) ? 0 : (b = Ea.exec(a)) ? (a = 60 * parseInt(b[2], 10), \"+\" === b[1] ? -a : a) : (b = Fa.exec(a)) ? (a = 60 * parseInt(b[2], 10) + parseInt(b[3], 10), \"+\" === b[1] ? -a : a) : 0;\n  }\n  function Q(a, b, d) {\n    b = b || 0;\n    d = d || 0;\n    var c = new Date(0);\n    c.setUTCFullYear(a, 0, 4);\n    a = c.getUTCDay() || 7;\n    b = 7 * b + d + 1 - a;\n    c.setUTCDate(c.getUTCDate() + b);\n    return c;\n  }\n  function Ga(a) {\n    var b = a % 100;\n    if (20 < b || 10 > b) {\n      switch(b % 10) {\n        case 1:\n          return a + \"st\";\n        case 2:\n          return a + \"nd\";\n        case 3:\n          return a + \"rd\";\n      }\n    }\n    return a + \"th\";\n  }\n  function Ha(a, b, d) {\n    var c = a.match(d), e = c.length;\n    for (a = 0; a < e; a++) {\n      d = b[c[a]] || L[c[a]], c[a] = d ? d : Ia(c[a]);\n    }\n    return function(a) {\n      for (var b = \"\", d = 0; d < e; d++) {\n        b = c[d] instanceof Function ? b + c[d](a, L) : b + c[d];\n      }\n      return b;\n    };\n  }\n  function Ia(a) {\n    return a.match(/\\[[\\s\\S]/) ? a.replace(/^\\[|]$/g, \"\") : a.replace(/\\\\/g, \"\");\n  }\n  function R(a, b) {\n    b = b || \"\";\n    var d = Math.abs(a), c = d % 60;\n    return (0 < a ? \"-\" : \"+\") + n(Math.floor(d / 60), 2) + b + n(c, 2);\n  }\n  function n(a, b) {\n    for (a = Math.abs(a).toString(); a.length < b;) {\n      a = \"0\" + a;\n    }\n    return a;\n  }\n  function M(a) {\n    a = String(a).split(\"\");\n    for (var b = []; a.length;) {\n      b.unshift(a.splice(-3).join(\"\"));\n    }\n    return b.join(\",\");\n  }\n  function Ja(a, b) {\n    void 0 === b && (b = 1);\n    return (100 * a).toPrecision(b + 2);\n  }\n  function S(a) {\n    return a && a.map(function(a, d) {\n      return u.createElement(a.tag, y({key:d}, a.attr), S(a.child));\n    });\n  }\n  function T(a) {\n    return function(b) {\n      return u.createElement(Ka, y({attr:y({}, a.attr)}, b), S(a.child));\n    };\n  }\n  function Ka(a) {\n    var b = function(b) {\n      var d = a.size || b.size || \"1em\";\n      if (b.className) {\n        var c = b.className;\n      }\n      a.className && (c = (c ? c + \" \" : \"\") + a.className);\n      var m = a.attr, g = a.title, l = [\"attr\", \"title\"], A = {}, k;\n      for (k in a) {\n        Object.prototype.hasOwnProperty.call(a, k) && 0 > l.indexOf(k) && (A[k] = a[k]);\n      }\n      if (null != a && \"function\" === typeof Object.getOwnPropertySymbols) {\n        var h = 0;\n        for (k = Object.getOwnPropertySymbols(a); h < k.length; h++) {\n          0 > l.indexOf(k[h]) && (A[k[h]] = a[k[h]]);\n        }\n      }\n      return u.createElement(\"svg\", y({stroke:\"currentColor\", fill:\"currentColor\", strokeWidth:\"0\"}, b.attr, m, A, {className:c, style:y({color:a.color || b.color}, b.style, a.style), height:d, width:d, xmlns:\"http://www.w3.org/2000/svg\"}), g && u.createElement(\"title\", null, g), a.children);\n    };\n    return void 0 !== U ? u.createElement(U.Consumer, null, function(a) {\n      return b(a);\n    }) : b(V);\n  }\n  function W(a, b) {\n    var d = b.css;\n    var f = [\"css\"];\n    if (null == b) {\n      b = {};\n    } else {\n      var e = {}, m = Object.keys(b), g;\n      for (g = 0; g < m.length; g++) {\n        var l = m[g];\n        0 <= f.indexOf(l) || (e[l] = b[l]);\n      }\n      b = e;\n    }\n    return c.jsx(a, C({css:C({}, d, {verticalAlign:\"text-bottom\"})}, b));\n  }\n  function La(a) {\n    return W(X, a);\n  }\n  function Ma(a) {\n    return W(Y, a);\n  }\n  function Z() {\n    var a = qa([\"\\n  html {\\n    box-sizing: border-box;\\n  }\\n  *,\\n  *:before,\\n  *:after {\\n    box-sizing: inherit;\\n  }\\n\\n  html,\\n  body,\\n  #root {\\n    height: 100%;\\n    margin: 0;\\n  }\\n\\n  body {\\n    \", \"\\n    font-size: 16px;\\n    line-height: 1.5;\\n    background: white;\\n    color: black;\\n  }\\n\\n  code {\\n    \", \"\\n  }\\n\\n  dd,\\n  ul {\\n    margin-left: 0;\\n    padding-left: 25px;\\n  }\\n\\n  #root {\\n    display: flex;\\n    flex-direction: column;\\n  }\\n\"]);\n    Z = function() {\n      return a;\n    };\n    return a;\n  }\n  function aa(a) {\n    return c.jsx(\"div\", {css:{textAlign:\"center\", flex:\"1\"}}, a.children);\n  }\n  function ba(a) {\n    return c.jsx(\"img\", C({}, a, {css:{maxWidth:\"90%\"}}));\n  }\n  function Na(a) {\n    a = a.data.totals;\n    var b = v(a.since), d = v(a.until);\n    return c.jsx(\"p\", null, \"From \", c.jsx(\"strong\", null, ca(b, \"MMM D\")), \" to\", \" \", c.jsx(\"strong\", null, ca(d, \"MMM D\")), \" unpkg served\", \" \", c.jsx(\"strong\", null, M(a.requests.all)), \" requests and a total of \", c.jsx(\"strong\", null, da(a.bandwidth.all)), \" of data to\", \" \", c.jsx(\"strong\", null, M(a.uniques.all)), \" unique visitors,\", \" \", c.jsx(\"strong\", null, Ja(a.requests.cached / a.requests.all, 2), \"%\"), \" \", \"of which were served from the cache.\");\n  }\n  function ea() {\n    var a = u.useState(\"object\" === typeof window && window.localStorage && window.localStorage.savedStats ? JSON.parse(window.localStorage.savedStats) : null)[0], b = !(!a || a.error);\n    return c.jsx(u.Fragment, null, c.jsx(\"div\", {css:{maxWidth:740, margin:\"0 auto\", padding:\"0 20px\"}}, c.jsx(c.Global, {styles:Oa}), c.jsx(\"header\", null, c.jsx(\"h1\", {css:{textTransform:\"uppercase\", textAlign:\"center\", fontSize:\"5em\"}}, \"unpkg\"), c.jsx(\"p\", null, \"unpkg is a fast, global content delivery network for everything on\", \" \", c.jsx(\"a\", {href:\"https://www.npmjs.com/\", css:h}, \"npm\"), \". Use it to quickly and easily load any file from any package using a URL like:\"), c.jsx(\"div\", {css:{textAlign:\"center\", \n    backgroundColor:\"#eee\", margin:\"2em 0\", padding:\"5px 0\"}}, \"unpkg.com/:package@:version/:file\"), b && c.jsx(Na, {data:a})), c.jsx(\"h3\", {css:{fontSize:\"1.6em\"}, id:\"examples\"}, \"Examples\"), c.jsx(\"p\", null, \"Using a fixed version:\"), c.jsx(\"ul\", null, c.jsx(\"li\", null, c.jsx(\"a\", {title:\"react.production.min.js\", href:\"/react@16.7.0/umd/react.production.min.js\", css:h}, \"unpkg.com/react@16.7.0/umd/react.production.min.js\")), c.jsx(\"li\", null, c.jsx(\"a\", {title:\"react-dom.production.min.js\", href:\"/react-dom@16.7.0/umd/react-dom.production.min.js\", \n    css:h}, \"unpkg.com/react-dom@16.7.0/umd/react-dom.production.min.js\"))), c.jsx(\"p\", null, \"You may also use a\", \" \", c.jsx(\"a\", {title:\"semver\", href:\"https://docs.npmjs.com/misc/semver\", css:h}, \"semver range\"), \" \", \"or a\", \" \", c.jsx(\"a\", {title:\"tags\", href:\"https://docs.npmjs.com/cli/dist-tag\", css:h}, \"tag\"), \" \", \"instead of a fixed version number, or omit the version/tag entirely to use the \", c.jsx(\"code\", null, \"latest\"), \" tag.\"), c.jsx(\"ul\", null, c.jsx(\"li\", null, c.jsx(\"a\", {title:\"react.production.min.js\", \n    href:\"/react@^16/umd/react.production.min.js\", css:h}, \"unpkg.com/react@^16/umd/react.production.min.js\")), c.jsx(\"li\", null, c.jsx(\"a\", {title:\"react.production.min.js\", href:\"/react/umd/react.production.min.js\", css:h}, \"unpkg.com/react/umd/react.production.min.js\"))), c.jsx(\"p\", null, \"If you omit the file path (i.e. use a \\u201cbare\\u201d URL), unpkg will serve the file specified by the \", c.jsx(\"code\", null, \"unpkg\"), \" field in\", \" \", c.jsx(\"code\", null, \"package.json\"), \", or fall back to \", \n    c.jsx(\"code\", null, \"main\"), \".\"), c.jsx(\"ul\", null, c.jsx(\"li\", null, c.jsx(\"a\", {title:\"jQuery\", href:\"/jquery\", css:h}, \"unpkg.com/jquery\")), c.jsx(\"li\", null, c.jsx(\"a\", {title:\"Three.js\", href:\"/three\", css:h}, \"unpkg.com/three\"))), c.jsx(\"p\", null, \"Append a \", c.jsx(\"code\", null, \"/\"), \" at the end of a URL to view a listing of all the files in a package.\"), c.jsx(\"ul\", null, c.jsx(\"li\", null, c.jsx(\"a\", {title:\"Index of the react package\", href:\"/react/\", css:h}, \"unpkg.com/react/\")), \n    c.jsx(\"li\", null, c.jsx(\"a\", {title:\"Index of the react-router package\", href:\"/react-router/\", css:h}, \"unpkg.com/react-router/\"))), c.jsx(\"h3\", {css:{fontSize:\"1.6em\"}, id:\"query-params\"}, \"Query Parameters\"), c.jsx(\"dl\", null, c.jsx(\"dt\", null, c.jsx(\"code\", null, \"?meta\")), c.jsx(\"dd\", null, \"Return metadata about any file in a package as JSON (e.g.\", c.jsx(\"code\", null, \"/any/file?meta\"), \")\"), c.jsx(\"dt\", null, c.jsx(\"code\", null, \"?module\")), c.jsx(\"dd\", null, \"Expands all\", \" \", c.jsx(\"a\", \n    {title:\"bare import specifiers\", href:\"https://html.spec.whatwg.org/multipage/webappapis.html#resolve-a-module-specifier\", css:h}, \"\\u201cbare\\u201d \", c.jsx(\"code\", null, \"import\"), \" specifiers\"), \" \", \"in JavaScript modules to unpkg URLs. This feature is\", \" \", c.jsx(\"em\", null, \"very experimental\"))), c.jsx(\"h3\", {css:{fontSize:\"1.6em\"}, id:\"cache-behavior\"}, \"Cache Behavior\"), c.jsx(\"p\", null, \"The CDN caches files based on their permanent URL, which includes the npm package version. This works because npm does not allow package authors to overwrite a package that has already been published with a different one at the same version number.\"), \n    c.jsx(\"p\", null, \"Browsers are instructed (via the \", c.jsx(\"code\", null, \"Cache-Control\"), \" header) to cache assets indefinitely (1 year).\"), c.jsx(\"p\", null, \"URLs that do not specify a package version number redirect to one that does. This is the \", c.jsx(\"code\", null, \"latest\"), \" version when no version is specified, or the \", c.jsx(\"code\", null, \"maxSatisfying\"), \" version when a\", \" \", c.jsx(\"a\", {title:\"semver\", href:\"https://github.com/npm/node-semver\", css:h}, \"semver version\"), \" \", \n    \"is given. Redirects are cached for 10 minutes at the CDN, 1 minute in browsers.\"), c.jsx(\"p\", null, \"If you want users to be able to use the latest version when you cut a new release, the best policy is to put the version number in the URL directly in your installation instructions. This will also load more quickly because we won't have to resolve the latest version and redirect them.\"), c.jsx(\"h3\", {css:{fontSize:\"1.6em\"}, id:\"workflow\"}, \"Workflow\"), c.jsx(\"p\", null, \"For npm package authors, unpkg relieves the burden of publishing your code to a CDN in addition to the npm registry. All you need to do is include your\", \n    \" \", c.jsx(\"a\", {title:\"UMD\", href:\"https://github.com/umdjs/umd\", css:h}, \"UMD\"), \" \", \"build in your npm package (not your repo, that's different!).\"), c.jsx(\"p\", null, \"You can do this easily using the following setup:\"), c.jsx(\"ul\", null, c.jsx(\"li\", null, \"Add the \", c.jsx(\"code\", null, \"umd\"), \" (or \", c.jsx(\"code\", null, \"dist\"), \") directory to your\", \" \", c.jsx(\"code\", null, \".gitignore\"), \" file\"), c.jsx(\"li\", null, \"Add the \", c.jsx(\"code\", null, \"umd\"), \" directory to your\", \" \", \n    c.jsx(\"a\", {title:\"package.json files array\", href:\"https://docs.npmjs.com/files/package.json#files\", css:h}, \"files array\"), \" \", \"in \", c.jsx(\"code\", null, \"package.json\")), c.jsx(\"li\", null, \"Use a build script to generate your UMD build in the\", \" \", c.jsx(\"code\", null, \"umd\"), \" directory when you publish\")), c.jsx(\"p\", null, \"That's it! Now when you \", c.jsx(\"code\", null, \"npm publish\"), \" you'll have a version available on unpkg as well.\"), c.jsx(\"h3\", {css:{fontSize:\"1.6em\"}, id:\"about\"}, \n    \"About\"), c.jsx(\"p\", null, \"unpkg is an\", \" \", c.jsx(\"a\", {title:\"unpkg on GitHub\", href:\"https://github.com/unpkg\", css:h}, \"open source\"), \" \", \"project built and maintained by\", \" \", c.jsx(\"a\", {title:\"mjackson on Twitter\", href:\"https://twitter.com/mjackson\", css:h}, \"Michael Jackson\"), \". unpkg is not affiliated with or supported by npm, Inc. in any way. Please do not contact npm for help with unpkg. Instead, please reach out to\", \" \", c.jsx(\"a\", {title:\"unpkg on Twitter\", href:\"https://twitter.com/unpkg\", \n    css:h}, \"@unpkg\"), \" \", \"with any questions or concerns.\"), c.jsx(\"p\", null, \"The unpkg CDN is powered by\", \" \", c.jsx(\"a\", {title:\"Cloudflare\", href:\"https://www.cloudflare.com\", css:h}, \"Cloudflare\"), \", one of the world's largest and fastest cloud network platforms.\", \" \", b && c.jsx(\"span\", null, \"In the past month, Cloudflare served over\", \" \", c.jsx(\"strong\", null, da(a.totals.bandwidth.all)), \" to\", \" \", c.jsx(\"strong\", null, M(a.totals.uniques.all)), \" unique unpkg users all over the world.\")), \n    c.jsx(\"div\", {css:{margin:\"4em 0\", display:\"flex\", justifyContent:\"center\"}}, c.jsx(aa, null, c.jsx(\"a\", {title:\"Cloudflare\", href:\"https://www.cloudflare.com\"}, c.jsx(ba, {src:\"/_client/46bc46bc8accec6a.png\", height:\"100\"})))), c.jsx(\"p\", null, \"The origin servers for unpkg are powered by\", \" \", c.jsx(\"a\", {title:\"Google Cloud\", href:\"https://cloud.google.com/\", css:h}, \"Google Cloud\"), \" \", \"and made possible by a generous donation from the\", \" \", c.jsx(\"a\", {title:\"Angular\", href:\"https://angular.io\", \n    css:h}, \"Angular web framework\"), \", one of the world's most popular libraries for building incredible user experiences on both desktop and mobile.\"), c.jsx(\"div\", {css:{margin:\"4em 0 0\", display:\"flex\", justifyContent:\"center\"}}, c.jsx(aa, null, c.jsx(\"a\", {title:\"Angular\", href:\"https://angular.io\"}, c.jsx(ba, {src:\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPoAAAD6CAMAAAC/MqoPAAAAz1BMVEUAAADUBy/DDi7dAzDdAzDdAzDdAzDDDi7DDi7DDi7dAzDdAzDdAzDDDi7DDi7DDi7dAzDdAzDdAzDDDi7DDi7DDi7dAzDdAzDDDi7DDi7dAzDdAzDDDi7DDi7dAzDDDi7fEz3HHTvugZjhh5f97/L78PLqYn7////aaHz74OX44eXmQmTSSmL3wMvww8vhI0rLLEjyobHppbHdAzDDDi7jMlfOO1XoUnHWWW/50Nj00tjscYvdd4nwkaTllqT0sL7stL7hRGPXBjDWBi/FDS4+JsiBAAAARXRSTlMAMDAwj9///9+PIHDPz3AgEGC/v2AQUK+vUJ/v75+AgP////////////////////////9AQP//////////////////r6+TKVt1AAAH7ElEQVR4AezUtaHDUBTA0I9mZtx/zHDMWOY+nQ3U6AsAAAAAAAAAAAAA8Em+f9Ts/v3713TDVK7esh3tRr9xPV+d7iCMtCf9KU5SJcKzXOvonaIU313VmjZK7zRtKXtsY/qI1OlZ9rN7Jb2rlza9IHS0JfoSV9D0wlxboa8oElljO5HeTU/C2E6kC5heN7Yz6QKm143tTLqA6QXrYzub/pxeKmFsV2buQllxZQ3DcJZ1jwuMS7AYGmx84Jy97/+exjNGWLv+zvst+O7gKfnrha6Kna4/ethhq9wUvdIf99G7EV8407xp1zpHevTuff8JrqN//3H/8PgPG0/njx5/2Hg6f/T4w8bTj/bo3ahKNWjdXpC76ty7B/9vMXz9Qbic+0cTOGz2JanRChw94LC55svyvPDNd5VH7+zrQQc2zPORJ/bi5ekhD5t94/zLJoAcOHrEYTNs+pU+M/CAowccNmBl/m1zD646evxhQ7f4Tl96cvzRW1WHjVs3/7HfswY6emv+v0Vy/Yo+oOnUP5rVT1F8SUVPeTnz8/bMaZZV8ipr+J1GDSeiD3/RRyJ61HTW+2bImWoTifxFY3pLQp/+Tp9J6G2eDuZMtflx0mMFffEnfamgd0g6nzNk1vD0R8qcUWZN86BdKXNGmTXr5jknzBlp1gC/4YQ5I82aqPkuZDkjzZprAL0lyxlp1rQB+mNY/iqv3WuY/gSgx6qc0WZNB6DflDWstGbvAPSVKGfEWbM+Ono32UdPezAdmCZn1FkTERPlDJ81PP0WKH+TX7K3oPw2Qm8pckadNW2Efi7IGXnWXEfosSBn5FnTQej3+ZzRZ80DhL7ic0afNWuEfsbnjD5rTiNkfM7osyZi9pzOGX3WvIDoLTpn9FnTJul8zvBZw9NjOmf0WdNh6XzOLJZs1vD0R6qcGU9UWfMUoq9EOfPO+feirFlD9HuinMmcL4CsYZ9e+Kb5sGtMus730nxnH4mioXYhyZmNc95vJVlzDaO3JA1bfqXPJTXbxuiPFTkzdV/pfqbImicYPVa8ML75Tn+reHvsYPSbgpwZuu90PxJkzR2MvhLkTL+iDwRZsz4a+qZG163ovXx3W4AOjc+ZhavofslnTcQNz5l8/Is+ybms4em36Jx5537R/Xs6a26D9BadM9nv9ILOmjZIfwbnTNL9nd5L4ax5CdJjOGcW7ne6X8JZ0wHp9+HHpvJP+hx+hHoA0ldszkzdn3Q/Y7NmDdLP2JzJ/qYXbNacRuDQnBnufrVghGZNRA7Nmf4ufUBlDU9vkY9N5S59Tj5CtVk6mDMLt0v3SyhreHoMPjaN6+gT8BGqw9K5nBm6OrofAVmD0YEHmP/VeLJ6epHv7v/804t9Kyxnkm49vZdiWbNG6Tewhl24erpfYjV7N0JH5Uxe7qPPcyprInYXzAtjle+79PqQH/BPL+a1oJzJ9tMLKGvaMP0xkzNDt5/uR0zWPIHpsZ3+ri7f6+n7Q/69nd6h6UjO5OVl9HkOZA1PXyE5s3CX0f0SyZo1TSdyJh9fTp/kQNbg9IjImaG7nO5HRNZE9Iicyf6LXgBZw9NvWXMG2wB9etE3zZCjj/RFQz7AZDm4wvj0Qi825gw4W9Z0cPp9W86gm9ieXuitbDmDzpQ1a5x+ZsoZeHP+6cUye85ws2RNdEh6N8fXOyi9pc8ZImvaB6UnPD09KD3W5wyRNR09nW9YpmYV9Ed8zlg24Z9e8KaZaugzumgMu6HPGSJr7kaC6XOGyJpIsQs+Z/isuSaht4Jzpj+u3z+TPRsEZ01bQn8cmjOJ27N/9wrS0Kx5IqHHoTmzsdO3oVnT0dMtOVPa6XN71ijpq8CcmTo73c8Cs2atpxtyJguhF/asEdKjsJxJXAjdp2FZE2kWljObMPrWnjVC+q2gnCnD6HN71tBPL4am6RuOXEU3HroBXzTIA0xiOHIV3XjoUvLpxbA4IGcSF0r3aUDWdET0+wE5swmnbwOy5oGIvgr42FAZTp8HfK5oLaKf2XNm6sLpfmbPmtNINPvHhrIm9ML+uaJINXPOJK4J3afmrJHRW8aGzTfN6NvcWLNtHd362FQ2o8+tj1A6emz8duLUNaP7mfErjJ0D0DPDkTPQC+MjlI7+yJYziWtK96kta57K6Ctbzmya07e2rFnL6Ddsj01lc/rc9gh1N5LNlDNT15zuZ6asiXS7sDw2ZQS9sDxCXRPSW4acSRxB96kha9pC+mNDzmwY+taQNU+E9NjwKeiSoc8NH5fuXDW97NctcwzdF4O6za+avvrcnl3Y6A5DQRS+PzMzF5FUMO/139KSeJmONdLe08EIvsR29+e9Of3n1TkdyXt6kI1OvtPP00CbX12n3zZBNzw6Tr/MokTV0m36qo5SbTtO0/uHYAO8k79ulHfy143yTv66Ud6J183VO/G6uXonWDfeu1P56WdWN9478brhtZYlp6+a4VTVKTW9X4dbi1OJ6ed1/DwD78Tr5uqdeN1cvROvm6t34nVz9U68bq7eidfN1Tvxurl6J0A3h6rxb0yfELrxLTo/nd5ndDPwTj66AeOP359+YYfzDZffm74CWTfwTrxurt6J183VO/G6uXonXjdX78Tr5uqdeN1cvROvm6t3ctYNGN9+ffoAGG7XcPdy+t5aN+BxWvxjsat3InTz79E7PekWQPbeyV83qOG//7PI/mhZlmVZlmVZlmVZlmXZPZmSvHpA7pEOAAAAAElFTkSuQmCC\", \n    width:\"200\"}))))), c.jsx(\"footer\", {css:{marginTop:\"5rem\", background:\"black\", color:\"#aaa\"}}, c.jsx(\"div\", {css:{maxWidth:740, padding:\"10px 20px\", margin:\"0 auto\", display:\"flex\", flexDirection:\"row\", alignItems:\"center\", justifyContent:\"space-between\"}}, c.jsx(\"p\", null, \"\\u00a9 \", (new Date).getFullYear(), \" UNPKG\"), c.jsx(\"p\", {css:{fontSize:\"1.5rem\"}}, c.jsx(\"a\", {title:\"Twitter\", href:\"https://twitter.com/unpkg\", css:{color:\"#aaa\", display:\"inline-block\", \":hover\":{color:\"white\"}}}, c.jsx(La, \n    null)), c.jsx(\"a\", {title:\"GitHub\", href:\"https://github.com/mjackson/unpkg\", css:{color:\"#aaa\", display:\"inline-block\", marginLeft:\"1rem\", \":hover\":{color:\"white\"}}}, c.jsx(Ma, null))))));\n  }\n  var Pa = \"default\" in u ? u[\"default\"] : u;\n  z = z && z.hasOwnProperty(\"default\") ? z[\"default\"] : z;\n  var G = D(function(a, b) {\n    function d(a) {\n      if (\"object\" === typeof a && null !== a) {\n        var b = a.$$typeof;\n        switch(b) {\n          case e:\n            switch(a = a.type, a) {\n              case r:\n              case p:\n              case g:\n              case h:\n              case l:\n              case q:\n                return a;\n              default:\n                switch(a = a && a.$$typeof, a) {\n                  case n:\n                  case t:\n                  case k:\n                    return a;\n                  default:\n                    return b;\n                }\n            }case w:\n          case x:\n          case m:\n            return b;\n        }\n      }\n    }\n    function c(a) {\n      return d(a) === p;\n    }\n    Object.defineProperty(b, \"__esModule\", {value:!0});\n    var e = (a = \"function\" === typeof Symbol && Symbol.for) ? Symbol.for(\"react.element\") : 60103, m = a ? Symbol.for(\"react.portal\") : 60106, g = a ? Symbol.for(\"react.fragment\") : 60107, l = a ? Symbol.for(\"react.strict_mode\") : 60108, h = a ? Symbol.for(\"react.profiler\") : 60114, k = a ? Symbol.for(\"react.provider\") : 60109, n = a ? Symbol.for(\"react.context\") : 60110, r = a ? Symbol.for(\"react.async_mode\") : 60111, p = a ? Symbol.for(\"react.concurrent_mode\") : 60111, t = a ? Symbol.for(\"react.forward_ref\") : \n    60112, q = a ? Symbol.for(\"react.suspense\") : 60113, x = a ? Symbol.for(\"react.memo\") : 60115, w = a ? Symbol.for(\"react.lazy\") : 60116;\n    b.typeOf = d;\n    b.AsyncMode = r;\n    b.ConcurrentMode = p;\n    b.ContextConsumer = n;\n    b.ContextProvider = k;\n    b.Element = e;\n    b.ForwardRef = t;\n    b.Fragment = g;\n    b.Lazy = w;\n    b.Memo = x;\n    b.Portal = m;\n    b.Profiler = h;\n    b.StrictMode = l;\n    b.Suspense = q;\n    b.isValidElementType = function(a) {\n      return \"string\" === typeof a || \"function\" === typeof a || a === g || a === p || a === h || a === l || a === q || \"object\" === typeof a && null !== a && (a.$$typeof === w || a.$$typeof === x || a.$$typeof === k || a.$$typeof === n || a.$$typeof === t);\n    };\n    b.isAsyncMode = function(a) {\n      return c(a) || d(a) === r;\n    };\n    b.isConcurrentMode = c;\n    b.isContextConsumer = function(a) {\n      return d(a) === n;\n    };\n    b.isContextProvider = function(a) {\n      return d(a) === k;\n    };\n    b.isElement = function(a) {\n      return \"object\" === typeof a && null !== a && a.$$typeof === e;\n    };\n    b.isForwardRef = function(a) {\n      return d(a) === t;\n    };\n    b.isFragment = function(a) {\n      return d(a) === g;\n    };\n    b.isLazy = function(a) {\n      return d(a) === w;\n    };\n    b.isMemo = function(a) {\n      return d(a) === x;\n    };\n    b.isPortal = function(a) {\n      return d(a) === m;\n    };\n    b.isProfiler = function(a) {\n      return d(a) === h;\n    };\n    b.isStrictMode = function(a) {\n      return d(a) === l;\n    };\n    b.isSuspense = function(a) {\n      return d(a) === q;\n    };\n  });\n  P(G);\n  var ha = D(function(a, b) {\n    (function() {\n      function a(a) {\n        if (\"object\" === typeof a && null !== a) {\n          var b = a.$$typeof;\n          switch(b) {\n            case m:\n              switch(a = a.type, a) {\n                case p:\n                case t:\n                case l:\n                case k:\n                case h:\n                case x:\n                  return a;\n                default:\n                  switch(a = a && a.$$typeof, a) {\n                    case r:\n                    case q:\n                    case n:\n                      return a;\n                    default:\n                      return b;\n                  }\n              }case F:\n            case w:\n            case g:\n              return b;\n          }\n        }\n      }\n      function c(b) {\n        return a(b) === t;\n      }\n      Object.defineProperty(b, \"__esModule\", {value:!0});\n      var e = \"function\" === typeof Symbol && Symbol.for, m = e ? Symbol.for(\"react.element\") : 60103, g = e ? Symbol.for(\"react.portal\") : 60106, l = e ? Symbol.for(\"react.fragment\") : 60107, h = e ? Symbol.for(\"react.strict_mode\") : 60108, k = e ? Symbol.for(\"react.profiler\") : 60114, n = e ? Symbol.for(\"react.provider\") : 60109, r = e ? Symbol.for(\"react.context\") : 60110, p = e ? Symbol.for(\"react.async_mode\") : 60111, t = e ? Symbol.for(\"react.concurrent_mode\") : 60111, q = e ? Symbol.for(\"react.forward_ref\") : \n      60112, x = e ? Symbol.for(\"react.suspense\") : 60113, w = e ? Symbol.for(\"react.memo\") : 60115, F = e ? Symbol.for(\"react.lazy\") : 60116;\n      e = function() {\n      };\n      var Qa = function(a) {\n        for (var b = arguments.length, c = Array(1 < b ? b - 1 : 0), d = 1; d < b; d++) {\n          c[d - 1] = arguments[d];\n        }\n        var p = 0;\n        b = \"Warning: \" + a.replace(/%s/g, function() {\n          return c[p++];\n        });\n        \"undefined\" !== typeof console && console.warn(b);\n        try {\n          throw Error(b);\n        } catch (fb) {\n        }\n      }, Ra = e = function(a, b) {\n        if (void 0 === b) {\n          throw Error(\"`lowPriorityWarning(condition, format, ...args)` requires a warning message argument\");\n        }\n        if (!a) {\n          for (var c = arguments.length, d = Array(2 < c ? c - 2 : 0), p = 2; p < c; p++) {\n            d[p - 2] = arguments[p];\n          }\n          Qa.apply(void 0, [b].concat(d));\n        }\n      }, fa = !1;\n      b.typeOf = a;\n      b.AsyncMode = p;\n      b.ConcurrentMode = t;\n      b.ContextConsumer = r;\n      b.ContextProvider = n;\n      b.Element = m;\n      b.ForwardRef = q;\n      b.Fragment = l;\n      b.Lazy = F;\n      b.Memo = w;\n      b.Portal = g;\n      b.Profiler = k;\n      b.StrictMode = h;\n      b.Suspense = x;\n      b.isValidElementType = function(a) {\n        return \"string\" === typeof a || \"function\" === typeof a || a === l || a === t || a === k || a === h || a === x || \"object\" === typeof a && null !== a && (a.$$typeof === F || a.$$typeof === w || a.$$typeof === n || a.$$typeof === r || a.$$typeof === q);\n      };\n      b.isAsyncMode = function(b) {\n        fa || (fa = !0, Ra(!1, \"The ReactIs.isAsyncMode() alias has been deprecated, and will be removed in React 17+. Update your code to use ReactIs.isConcurrentMode() instead. It has the exact same API.\"));\n        return c(b) || a(b) === p;\n      };\n      b.isConcurrentMode = c;\n      b.isContextConsumer = function(b) {\n        return a(b) === r;\n      };\n      b.isContextProvider = function(b) {\n        return a(b) === n;\n      };\n      b.isElement = function(a) {\n        return \"object\" === typeof a && null !== a && a.$$typeof === m;\n      };\n      b.isForwardRef = function(b) {\n        return a(b) === q;\n      };\n      b.isFragment = function(b) {\n        return a(b) === l;\n      };\n      b.isLazy = function(b) {\n        return a(b) === F;\n      };\n      b.isMemo = function(b) {\n        return a(b) === w;\n      };\n      b.isPortal = function(b) {\n        return a(b) === g;\n      };\n      b.isProfiler = function(b) {\n        return a(b) === k;\n      };\n      b.isStrictMode = function(b) {\n        return a(b) === h;\n      };\n      b.isSuspense = function(b) {\n        return a(b) === x;\n      };\n    })();\n  });\n  P(ha);\n  var ia = D(function(a) {\n    a.exports = ha;\n  }), ja = Object.getOwnPropertySymbols, Sa = Object.prototype.hasOwnProperty, Ta = Object.prototype.propertyIsEnumerable, Ua = function() {\n    try {\n      if (!Object.assign) {\n        return !1;\n      }\n      var a = new String(\"abc\");\n      a[5] = \"de\";\n      if (\"5\" === Object.getOwnPropertyNames(a)[0]) {\n        return !1;\n      }\n      var b = {};\n      for (a = 0; 10 > a; a++) {\n        b[\"_\" + String.fromCharCode(a)] = a;\n      }\n      if (\"0123456789\" !== Object.getOwnPropertyNames(b).map(function(a) {\n        return b[a];\n      }).join(\"\")) {\n        return !1;\n      }\n      var c = {};\n      \"abcdefghijklmnopqrst\".split(\"\").forEach(function(a) {\n        c[a] = a;\n      });\n      return \"abcdefghijklmnopqrst\" !== Object.keys(Object.assign({}, c)).join(\"\") ? !1 : !0;\n    } catch (f) {\n      return !1;\n    }\n  }() ? Object.assign : function(a, b) {\n    if (null === a || void 0 === a) {\n      throw new TypeError(\"Object.assign cannot be called with null or undefined\");\n    }\n    var c = Object(a);\n    for (var f, e = 1; e < arguments.length; e++) {\n      var m = Object(arguments[e]);\n      for (var g in m) {\n        Sa.call(m, g) && (c[g] = m[g]);\n      }\n      if (ja) {\n        f = ja(m);\n        for (var l = 0; l < f.length; l++) {\n          Ta.call(m, f[l]) && (c[f[l]] = m[f[l]]);\n        }\n      }\n    }\n    return c;\n  }, J = function() {\n  }, K = {}, ra = Function.call.bind(Object.prototype.hasOwnProperty);\n  J = function(a) {\n    a = \"Warning: \" + a;\n    \"undefined\" !== typeof console && console.error(a);\n    try {\n      throw Error(a);\n    } catch (b) {\n    }\n  };\n  I.resetWarningCache = function() {\n    K = {};\n  };\n  var Va = Function.call.bind(Object.prototype.hasOwnProperty), B = function() {\n  };\n  B = function(a) {\n    a = \"Warning: \" + a;\n    \"undefined\" !== typeof console && console.error(a);\n    try {\n      throw Error(a);\n    } catch (b) {\n    }\n  };\n  var Wa = function(a, b) {\n    function c(a, b) {\n      return a === b ? 0 !== a || 1 / a === 1 / b : a !== a && b !== b;\n    }\n    function f(a) {\n      this.message = a;\n      this.stack = \"\";\n    }\n    function e(a) {\n      function c(c, t, q, e, l, k, g) {\n        e = e || \"<<anonymous>>\";\n        k = k || q;\n        if (\"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\" !== g) {\n          if (b) {\n            throw c = Error(\"Calling PropTypes validators directly is not supported by the `prop-types` package. Use `PropTypes.checkPropTypes()` to call them. Read more at http://fb.me/use-check-prop-types\"), c.name = \"Invariant Violation\", c;\n          }\n          \"undefined\" !== typeof console && (g = e + \":\" + q, !d[g] && 3 > p && (B(\"You are manually calling a React.PropTypes validation function for the `\" + k + \"` prop on `\" + e + \"`. This is deprecated and will throw in the standalone `prop-types` package. You may be seeing this warning due to a third-party PropTypes library. See https://fb.me/react-warning-dont-call-proptypes for details.\"), d[g] = !0, p++));\n        }\n        return null == t[q] ? c ? null === t[q] ? new f(\"The \" + l + \" `\" + k + \"` is marked as required \" + (\"in `\" + e + \"`, but its value is `null`.\")) : new f(\"The \" + l + \" `\" + k + \"` is marked as required in \" + (\"`\" + e + \"`, but its value is `undefined`.\")) : null : a(t, q, e, l, k);\n      }\n      var d = {}, p = 0, e = c.bind(null, !1);\n      e.isRequired = c.bind(null, !0);\n      return e;\n    }\n    function m(a) {\n      return e(function(b, c, d, p, e, k) {\n        b = b[c];\n        return l(b) !== a ? (b = h(b), new f(\"Invalid \" + p + \" `\" + e + \"` of type \" + (\"`\" + b + \"` supplied to `\" + d + \"`, expected \") + (\"`\" + a + \"`.\"))) : null;\n      });\n    }\n    function g(b) {\n      switch(typeof b) {\n        case \"number\":\n        case \"string\":\n        case \"undefined\":\n          return !0;\n        case \"boolean\":\n          return !b;\n        case \"object\":\n          if (Array.isArray(b)) {\n            return b.every(g);\n          }\n          if (null === b || a(b)) {\n            return !0;\n          }\n          var c = b && (n && b[n] || b[\"@@iterator\"]);\n          var d = \"function\" === typeof c ? c : void 0;\n          if (d) {\n            if (c = d.call(b), d !== b.entries) {\n              for (; !(b = c.next()).done;) {\n                if (!g(b.value)) {\n                  return !1;\n                }\n              }\n            } else {\n              for (; !(b = c.next()).done;) {\n                if ((b = b.value) && !g(b[1])) {\n                  return !1;\n                }\n              }\n            }\n          } else {\n            return !1;\n          }\n          return !0;\n        default:\n          return !1;\n      }\n    }\n    function l(a) {\n      var b = typeof a;\n      return Array.isArray(a) ? \"array\" : a instanceof RegExp ? \"object\" : \"symbol\" === b || a && (\"Symbol\" === a[\"@@toStringTag\"] || \"function\" === typeof Symbol && a instanceof Symbol) ? \"symbol\" : b;\n    }\n    function h(a) {\n      if (\"undefined\" === typeof a || null === a) {\n        return \"\" + a;\n      }\n      var b = l(a);\n      if (\"object\" === b) {\n        if (a instanceof Date) {\n          return \"date\";\n        }\n        if (a instanceof RegExp) {\n          return \"regexp\";\n        }\n      }\n      return b;\n    }\n    function k(a) {\n      a = h(a);\n      switch(a) {\n        case \"array\":\n        case \"object\":\n          return \"an \" + a;\n        case \"boolean\":\n        case \"date\":\n        case \"regexp\":\n          return \"a \" + a;\n        default:\n          return a;\n      }\n    }\n    var n = \"function\" === typeof Symbol && Symbol.iterator, r = {array:m(\"array\"), bool:m(\"boolean\"), func:m(\"function\"), number:m(\"number\"), object:m(\"object\"), string:m(\"string\"), symbol:m(\"symbol\"), any:e(E), arrayOf:function(a) {\n      return e(function(b, c, d, e, p) {\n        if (\"function\" !== typeof a) {\n          return new f(\"Property `\" + p + \"` of component `\" + d + \"` has invalid PropType notation inside arrayOf.\");\n        }\n        b = b[c];\n        if (!Array.isArray(b)) {\n          return b = l(b), new f(\"Invalid \" + e + \" `\" + p + \"` of type \" + (\"`\" + b + \"` supplied to `\" + d + \"`, expected an array.\"));\n        }\n        for (c = 0; c < b.length; c++) {\n          var q = a(b, c, d, e, p + \"[\" + c + \"]\", \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\");\n          if (q instanceof Error) {\n            return q;\n          }\n        }\n        return null;\n      });\n    }, element:function() {\n      return e(function(b, c, d, e, k) {\n        b = b[c];\n        return a(b) ? null : (b = l(b), new f(\"Invalid \" + e + \" `\" + k + \"` of type \" + (\"`\" + b + \"` supplied to `\" + d + \"`, expected a single ReactElement.\")));\n      });\n    }(), elementType:function() {\n      return e(function(a, b, c, d, e) {\n        a = a[b];\n        return ia.isValidElementType(a) ? null : (a = l(a), new f(\"Invalid \" + d + \" `\" + e + \"` of type \" + (\"`\" + a + \"` supplied to `\" + c + \"`, expected a single ReactElement type.\")));\n      });\n    }(), instanceOf:function(a) {\n      return e(function(b, c, d, e, k) {\n        if (!(b[c] instanceof a)) {\n          var q = a.name || \"<<anonymous>>\";\n          b = b[c];\n          b = b.constructor && b.constructor.name ? b.constructor.name : \"<<anonymous>>\";\n          return new f(\"Invalid \" + e + \" `\" + k + \"` of type \" + (\"`\" + b + \"` supplied to `\" + d + \"`, expected \") + (\"instance of `\" + q + \"`.\"));\n        }\n        return null;\n      });\n    }, node:function() {\n      return e(function(a, b, c, d, e) {\n        return g(a[b]) ? null : new f(\"Invalid \" + d + \" `\" + e + \"` supplied to \" + (\"`\" + c + \"`, expected a ReactNode.\"));\n      });\n    }(), objectOf:function(a) {\n      return e(function(b, c, d, e, k) {\n        if (\"function\" !== typeof a) {\n          return new f(\"Property `\" + k + \"` of component `\" + d + \"` has invalid PropType notation inside objectOf.\");\n        }\n        b = b[c];\n        c = l(b);\n        if (\"object\" !== c) {\n          return new f(\"Invalid \" + e + \" `\" + k + \"` of type \" + (\"`\" + c + \"` supplied to `\" + d + \"`, expected an object.\"));\n        }\n        for (var g in b) {\n          if (Va(b, g) && (c = a(b, g, d, e, k + \".\" + g, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\"), c instanceof Error)) {\n            return c;\n          }\n        }\n        return null;\n      });\n    }, oneOf:function(a) {\n      return Array.isArray(a) ? e(function(b, d, e, k, g) {\n        b = b[d];\n        for (d = 0; d < a.length; d++) {\n          if (c(b, a[d])) {\n            return null;\n          }\n        }\n        d = JSON.stringify(a, function(a, b) {\n          return \"symbol\" === h(b) ? String(b) : b;\n        });\n        return new f(\"Invalid \" + k + \" `\" + g + \"` of value `\" + String(b) + \"` \" + (\"supplied to `\" + e + \"`, expected one of \" + d + \".\"));\n      }) : (1 < arguments.length ? B(\"Invalid arguments supplied to oneOf, expected an array, got \" + arguments.length + \" arguments. A common mistake is to write oneOf(x, y, z) instead of oneOf([x, y, z]).\") : B(\"Invalid argument supplied to oneOf, expected an array.\"), E);\n    }, oneOfType:function(a) {\n      if (!Array.isArray(a)) {\n        return B(\"Invalid argument supplied to oneOfType, expected an instance of array.\"), E;\n      }\n      for (var b = 0; b < a.length; b++) {\n        var c = a[b];\n        if (\"function\" !== typeof c) {\n          return B(\"Invalid argument supplied to oneOfType. Expected an array of check functions, but received \" + k(c) + \" at index \" + b + \".\"), E;\n        }\n      }\n      return e(function(b, c, d, e, k) {\n        for (var g = 0; g < a.length; g++) {\n          if (null == (0,a[g])(b, c, d, e, k, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\")) {\n            return null;\n          }\n        }\n        return new f(\"Invalid \" + e + \" `\" + k + \"` supplied to \" + (\"`\" + d + \"`.\"));\n      });\n    }, shape:function(a) {\n      return e(function(b, c, d, e, k) {\n        b = b[c];\n        c = l(b);\n        if (\"object\" !== c) {\n          return new f(\"Invalid \" + e + \" `\" + k + \"` of type `\" + c + \"` \" + (\"supplied to `\" + d + \"`, expected `object`.\"));\n        }\n        for (var g in a) {\n          if (c = a[g]) {\n            if (c = c(b, g, d, e, k + \".\" + g, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\")) {\n              return c;\n            }\n          }\n        }\n        return null;\n      });\n    }, exact:function(a) {\n      return e(function(b, c, d, e, k) {\n        var g = b[c], h = l(g);\n        if (\"object\" !== h) {\n          return new f(\"Invalid \" + e + \" `\" + k + \"` of type `\" + h + \"` \" + (\"supplied to `\" + d + \"`, expected `object`.\"));\n        }\n        h = Ua({}, b[c], a);\n        for (var m in h) {\n          h = a[m];\n          if (!h) {\n            return new f(\"Invalid \" + e + \" `\" + k + \"` key `\" + m + \"` supplied to `\" + d + \"`.\\nBad object: \" + JSON.stringify(b[c], null, \"  \") + \"\\nValid keys: \" + JSON.stringify(Object.keys(a), null, \"  \"));\n          }\n          if (h = h(g, m, d, e, k + \".\" + m, \"SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED\")) {\n            return h;\n          }\n        }\n        return null;\n      });\n    }};\n    f.prototype = Error.prototype;\n    r.checkPropTypes = I;\n    r.resetWarningCache = I.resetWarningCache;\n    return r.PropTypes = r;\n  };\n  G = D(function(a) {\n    a.exports = Wa(ia.isElement, !0);\n  });\n  let ka = \"B kB MB GB TB PB EB ZB YB\".split(\" \"), la = (a, b) => {\n    let c = a;\n    \"string\" === typeof b ? c = a.toLocaleString(b) : !0 === b && (c = a.toLocaleString());\n    return c;\n  };\n  var da = (a, b) => {\n    if (!Number.isFinite(a)) {\n      throw new TypeError(`Expected a finite number, got ${typeof a}: ${a}`);\n    }\n    b = Object.assign({}, b);\n    if (b.signed && 0 === a) {\n      return \" 0 B\";\n    }\n    var c = 0 > a;\n    let f = c ? \"-\" : b.signed ? \"+\" : \"\";\n    c && (a = -a);\n    if (1 > a) {\n      return a = la(a, b.locale), f + a + \" B\";\n    }\n    c = Math.min(Math.floor(Math.log10(a) / 3), ka.length - 1);\n    a = Number((a / Math.pow(1000, c)).toPrecision(3));\n    a = la(a, b.locale);\n    return f + a + \" \" + ka[c];\n  }, N = function(a) {\n    var b = new Date(a.getTime());\n    a = b.getTimezoneOffset();\n    b.setSeconds(0, 0);\n    b = b.getTime() % 60000;\n    return 60000 * a + b;\n  }, Xa = /[T ]/, Ya = /:/, Za = /^(\\d{2})$/, $a = [/^([+-]\\d{2})$/, /^([+-]\\d{3})$/, /^([+-]\\d{4})$/], ab = /^(\\d{4})/, bb = [/^([+-]\\d{4})/, /^([+-]\\d{5})/, /^([+-]\\d{6})/], ta = /^-(\\d{2})$/, ua = /^-?(\\d{3})$/, va = /^-?(\\d{2})-?(\\d{2})$/, wa = /^-?W(\\d{2})$/, xa = /^-?W(\\d{2})-?(\\d{1})$/, za = /^(\\d{2}([.,]\\d*)?)$/, Aa = /^(\\d{2}):?(\\d{2}([.,]\\d*)?)$/, Ba = /^(\\d{2}):?(\\d{2}):?(\\d{2}([.,]\\d*)?)$/, cb = /([Z+-].*)$/, Da = /^(Z)$/, Ea = /^([+-])(\\d{2})$/, Fa = /^([+-])(\\d{2}):?(\\d{2})$/, v = function(a, \n  b) {\n    if (a instanceof Date) {\n      return new Date(a.getTime());\n    }\n    if (\"string\" !== typeof a) {\n      return new Date(a);\n    }\n    var c = (b || {}).additionalDigits;\n    c = null == c ? 2 : Number(c);\n    var f = a.split(Xa);\n    Ya.test(f[0]) ? (b = null, f = f[0]) : (b = f[0], f = f[1]);\n    if (f) {\n      var e = cb.exec(f);\n      if (e) {\n        var h = f.replace(e[1], \"\");\n        var g = e[1];\n      } else {\n        h = f;\n      }\n    }\n    f = $a[c];\n    c = bb[c];\n    (c = ab.exec(b) || c.exec(b)) ? (f = c[1], c = parseInt(f, 10), b = b.slice(f.length)) : (c = Za.exec(b) || f.exec(b)) ? (f = c[1], c = 100 * parseInt(f, 10), b = b.slice(f.length)) : (c = null, b = void 0);\n    return (b = sa(b, c)) ? (a = b.getTime(), b = 0, h && (b = ya(h)), g ? h = 60000 * Ca(g) : (c = a + b, g = new Date(c), h = N(g), c = new Date(c), c.setDate(g.getDate() + 1), g = N(c) - N(g), 0 < g && (h += g)), new Date(a + b + h)) : new Date(a);\n  }, ma = function(a) {\n    a = v(a);\n    a.setHours(0, 0, 0, 0);\n    return a;\n  }, na = function(a) {\n    var b = v(a), c = v(b);\n    a = new Date(0);\n    a.setFullYear(c.getFullYear(), 0, 1);\n    a.setHours(0, 0, 0, 0);\n    b = ma(b);\n    a = ma(a);\n    b = b.getTime() - 60000 * b.getTimezoneOffset();\n    a = a.getTime() - 60000 * a.getTimezoneOffset();\n    return Math.round((b - a) / 86400000) + 1;\n  }, H = function(a) {\n    var b = {weekStartsOn:1};\n    b = b ? Number(b.weekStartsOn) || 0 : 0;\n    a = v(a);\n    var c = a.getDay();\n    b = (c < b ? 7 : 0) + c - b;\n    a.setDate(a.getDate() - b);\n    a.setHours(0, 0, 0, 0);\n    return a;\n  }, O = function(a) {\n    a = v(a);\n    var b = a.getFullYear(), c = new Date(0);\n    c.setFullYear(b + 1, 0, 4);\n    c.setHours(0, 0, 0, 0);\n    c = H(c);\n    var f = new Date(0);\n    f.setFullYear(b, 0, 4);\n    f.setHours(0, 0, 0, 0);\n    f = H(f);\n    return a.getTime() >= c.getTime() ? b + 1 : a.getTime() >= f.getTime() ? b : b - 1;\n  }, oa = function(a) {\n    var b = v(a);\n    a = H(b).getTime();\n    b = O(b);\n    var c = new Date(0);\n    c.setFullYear(b, 0, 4);\n    c.setHours(0, 0, 0, 0);\n    b = H(c);\n    a -= b.getTime();\n    return Math.round(a / 604800000) + 1;\n  }, db = \"M MM Q D DD DDD DDDD d E W WW YY YYYY GG GGGG H HH h hh m mm s ss S SS SSS Z ZZ X x\".split(\" \"), eb = function(a) {\n    var b = [], c;\n    for (c in a) {\n      a.hasOwnProperty(c) && b.push(c);\n    }\n    a = db.concat(b).sort().reverse();\n    return new RegExp(\"(\\\\[[^\\\\[]*\\\\])|(\\\\\\\\)?(\" + a.join(\"|\") + \"|.)\", \"g\");\n  };\n  (function() {\n    var a = {lessThanXSeconds:{one:\"less than a second\", other:\"less than {{count}} seconds\"}, xSeconds:{one:\"1 second\", other:\"{{count}} seconds\"}, halfAMinute:\"half a minute\", lessThanXMinutes:{one:\"less than a minute\", other:\"less than {{count}} minutes\"}, xMinutes:{one:\"1 minute\", other:\"{{count}} minutes\"}, aboutXHours:{one:\"about 1 hour\", other:\"about {{count}} hours\"}, xHours:{one:\"1 hour\", other:\"{{count}} hours\"}, xDays:{one:\"1 day\", other:\"{{count}} days\"}, aboutXMonths:{one:\"about 1 month\", \n    other:\"about {{count}} months\"}, xMonths:{one:\"1 month\", other:\"{{count}} months\"}, aboutXYears:{one:\"about 1 year\", other:\"about {{count}} years\"}, xYears:{one:\"1 year\", other:\"{{count}} years\"}, overXYears:{one:\"over 1 year\", other:\"over {{count}} years\"}, almostXYears:{one:\"almost 1 year\", other:\"almost {{count}} years\"}};\n    return {localize:function(b, c, f) {\n      f = f || {};\n      b = \"string\" === typeof a[b] ? a[b] : 1 === c ? a[b].one : a[b].other.replace(\"{{count}}\", c);\n      return f.addSuffix ? 0 < f.comparison ? \"in \" + b : b + \" ago\" : b;\n    }};\n  })();\n  var pa = function() {\n    var a = \"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec\".split(\" \"), b = \"January February March April May June July August September October November December\".split(\" \"), c = \"Su Mo Tu We Th Fr Sa\".split(\" \"), f = \"Sun Mon Tue Wed Thu Fri Sat\".split(\" \"), e = \"Sunday Monday Tuesday Wednesday Thursday Friday Saturday\".split(\" \"), h = [\"AM\", \"PM\"], g = [\"am\", \"pm\"], l = [\"a.m.\", \"p.m.\"], n = {MMM:function(b) {\n      return a[b.getMonth()];\n    }, MMMM:function(a) {\n      return b[a.getMonth()];\n    }, dd:function(a) {\n      return c[a.getDay()];\n    }, ddd:function(a) {\n      return f[a.getDay()];\n    }, dddd:function(a) {\n      return e[a.getDay()];\n    }, A:function(a) {\n      return 1 <= a.getHours() / 12 ? h[1] : h[0];\n    }, a:function(a) {\n      return 1 <= a.getHours() / 12 ? g[1] : g[0];\n    }, aa:function(a) {\n      return 1 <= a.getHours() / 12 ? l[1] : l[0];\n    }};\n    \"M D DDD d Q W\".split(\" \").forEach(function(a) {\n      n[a + \"o\"] = function(b, c) {\n        return Ga(c[a](b));\n      };\n    });\n    return {formatters:n, formattingTokensRegExp:eb(n)};\n  }(), L = {M:function(a) {\n    return a.getMonth() + 1;\n  }, MM:function(a) {\n    return n(a.getMonth() + 1, 2);\n  }, Q:function(a) {\n    return Math.ceil((a.getMonth() + 1) / 3);\n  }, D:function(a) {\n    return a.getDate();\n  }, DD:function(a) {\n    return n(a.getDate(), 2);\n  }, DDD:function(a) {\n    return na(a);\n  }, DDDD:function(a) {\n    return n(na(a), 3);\n  }, d:function(a) {\n    return a.getDay();\n  }, E:function(a) {\n    return a.getDay() || 7;\n  }, W:function(a) {\n    return oa(a);\n  }, WW:function(a) {\n    return n(oa(a), 2);\n  }, YY:function(a) {\n    return n(a.getFullYear(), 4).substr(2);\n  }, YYYY:function(a) {\n    return n(a.getFullYear(), 4);\n  }, GG:function(a) {\n    return String(O(a)).substr(2);\n  }, GGGG:function(a) {\n    return O(a);\n  }, H:function(a) {\n    return a.getHours();\n  }, HH:function(a) {\n    return n(a.getHours(), 2);\n  }, h:function(a) {\n    a = a.getHours();\n    return 0 === a ? 12 : 12 < a ? a % 12 : a;\n  }, hh:function(a) {\n    return n(L.h(a), 2);\n  }, m:function(a) {\n    return a.getMinutes();\n  }, mm:function(a) {\n    return n(a.getMinutes(), 2);\n  }, s:function(a) {\n    return a.getSeconds();\n  }, ss:function(a) {\n    return n(a.getSeconds(), 2);\n  }, S:function(a) {\n    return Math.floor(a.getMilliseconds() / 100);\n  }, SS:function(a) {\n    return n(Math.floor(a.getMilliseconds() / 10), 2);\n  }, SSS:function(a) {\n    return n(a.getMilliseconds(), 3);\n  }, Z:function(a) {\n    return R(a.getTimezoneOffset(), \":\");\n  }, ZZ:function(a) {\n    return R(a.getTimezoneOffset());\n  }, X:function(a) {\n    return Math.floor(a.getTime() / 1000);\n  }, x:function(a) {\n    return a.getTime();\n  }}, ca = function(a, b, c) {\n    b = b ? String(b) : \"YYYY-MM-DDTHH:mm:ss.SSSZ\";\n    var d = (c || {}).locale;\n    c = pa.formatters;\n    var e = pa.formattingTokensRegExp;\n    d && d.format && d.format.formatters && (c = d.format.formatters, d.format.formattingTokensRegExp && (e = d.format.formattingTokensRegExp));\n    a = v(a);\n    if (a instanceof Date) {\n      d = !isNaN(a);\n    } else {\n      throw new TypeError(toString.call(a) + \" is not an instance of Date\");\n    }\n    return d ? Ha(b, c, e)(a) : \"Invalid Date\";\n  }, V = {color:void 0, size:void 0, className:void 0, style:void 0, attr:void 0}, U = u.createContext && u.createContext(V), y = function() {\n    y = Object.assign || function(a) {\n      for (var b, c = 1, f = arguments.length; c < f; c++) {\n        b = arguments[c];\n        for (var e in b) {\n          Object.prototype.hasOwnProperty.call(b, e) && (a[e] = b[e]);\n        }\n      }\n      return a;\n    };\n    return y.apply(this, arguments);\n  }, Y = function(a) {\n    return T({tag:\"svg\", attr:{viewBox:\"0 0 496 512\"}, child:[{tag:\"path\", attr:{d:\"M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8zM97.2 352.9c-1.3 1-1 3.3.7 5.2 1.6 1.6 3.9 2.3 5.2 1 1.3-1 1-3.3-.7-5.2-1.6-1.6-3.9-2.3-5.2-1zm-10.8-8.1c-.7 1.3.3 2.9 2.3 3.9 1.6 1 3.6.7 4.3-.7.7-1.3-.3-2.9-2.3-3.9-2-.6-3.6-.3-4.3.7zm32.4 35.6c-1.6 1.3-1 4.3 1.3 6.2 2.3 2.3 5.2 2.6 6.5 1 1.3-1.3.7-4.3-1.3-6.2-2.2-2.3-5.2-2.6-6.5-1zm-11.4-14.7c-1.6 1-1.6 3.6 0 5.9 1.6 2.3 4.3 3.3 5.6 2.3 1.6-1.3 1.6-3.9 0-6.2-1.4-2.3-4-3.3-5.6-2z\"}}]})(a);\n  };\n  Y.displayName = \"FaGithub\";\n  var X = function(a) {\n    return T({tag:\"svg\", attr:{viewBox:\"0 0 512 512\"}, child:[{tag:\"path\", attr:{d:\"M459.37 151.716c.325 4.548.325 9.097.325 13.645 0 138.72-105.583 298.558-298.558 298.558-59.452 0-114.68-17.219-161.137-47.106 8.447.974 16.568 1.299 25.34 1.299 49.055 0 94.213-16.568 130.274-44.832-46.132-.975-84.792-31.188-98.112-72.772 6.498.974 12.995 1.624 19.818 1.624 9.421 0 18.843-1.3 27.614-3.573-48.081-9.747-84.143-51.98-84.143-102.985v-1.299c13.969 7.797 30.214 12.67 47.431 13.319-28.264-18.843-46.781-51.005-46.781-87.391 0-19.492 5.197-37.36 14.294-52.954 51.655 63.675 129.3 105.258 216.365 109.807-1.624-7.797-2.599-15.918-2.599-24.04 0-57.828 46.782-104.934 104.934-104.934 30.213 0 57.502 12.67 76.67 33.137 23.715-4.548 46.456-13.32 66.599-25.34-7.798 24.366-24.366 44.833-46.132 57.827 21.117-2.273 41.584-8.122 60.426-16.243-14.292 20.791-32.161 39.308-52.628 54.253z\"}}]})(a);\n  };\n  X.displayName = \"FaTwitter\";\n  var Oa = c.css(Z(), '\\nfont-family: -apple-system,\\n  BlinkMacSystemFont,\\n  \"Segoe UI\",\\n  \"Roboto\",\\n  \"Oxygen\",\\n  \"Ubuntu\",\\n  \"Cantarell\",\\n  \"Fira Sans\",\\n  \"Droid Sans\",\\n  \"Helvetica Neue\",\\n  sans-serif;\\n', \"\\nfont-family: Menlo,\\n  Monaco,\\n  Lucida Console,\\n  Liberation Mono,\\n  DejaVu Sans Mono,\\n  Bitstream Vera Sans Mono,\\n  Courier New,\\n  monospace;\\n\"), h = {color:\"#0076ff\", textDecoration:\"none\", \":hover\":{textDecoration:\"underline\"}};\n  ea.propTypes = {location:G.object, children:G.node};\n  z.render(Pa.createElement(ea, null), document.getElementById(\"root\"));\n})(React, ReactDOM, emotionCore);\n\n"}]}];

// Virtual module id; see rollup.config.js

function getEntryPoint(name, format) {
  let entryPoints;
  entryManifest.forEach(manifest => {
    if (name in manifest) {
      entryPoints = manifest[name];
    }
  });

  if (entryPoints) {
    return entryPoints.find(e => e.format === format);
  }

  return null;
}

function getGlobalScripts(entryPoint, globalURLs) {
  return entryPoint.globalImports.map(id => {
    if (process.env.NODE_ENV !== 'production') {
      if (!globalURLs[id]) {
        throw new Error('Missing global URL for id "%s"', id);
      }
    }

    return React.createElement('script', {
      src: globalURLs[id]
    });
  });
}

function getScripts(entryName, format, globalURLs) {
  const entryPoint = getEntryPoint(entryName, format);
  if (!entryPoint) return [];
  return getGlobalScripts(entryPoint, globalURLs).concat(createScript(entryPoint.code));
}

const doctype = '<!DOCTYPE html>';
const globalURLs = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? {
  '@emotion/core': '/@emotion/core@10.0.6/dist/core.umd.min.js',
  react: '/react@16.8.6/umd/react.production.min.js',
  'react-dom': '/react-dom@16.8.6/umd/react-dom.production.min.js'
} : {
  '@emotion/core': '/@emotion/core@10.0.6/dist/core.umd.min.js',
  react: '/react@16.8.6/umd/react.development.js',
  'react-dom': '/react-dom@16.8.6/umd/react-dom.development.js'
};

function byVersion(a, b) {
  return semver.lt(a, b) ? -1 : semver.gt(a, b) ? 1 : 0;
}

async function getAvailableVersions(packageName, log) {
  const versionsAndTags = await getVersionsAndTags(packageName, log);
  return versionsAndTags ? versionsAndTags.versions.sort(byVersion) : [];
}

async function serveBrowsePage(req, res) {
  const availableVersions = await getAvailableVersions(req.packageName, req.log);
  const data = {
    packageName: req.packageName,
    packageVersion: req.packageVersion,
    availableVersions: availableVersions,
    filename: req.filename,
    target: req.browseTarget
  };
  const content = createHTML$1(server$1.renderToString(React.createElement(App, data)));
  const elements = getScripts('browse', 'iife', globalURLs);
  const html = doctype + server$1.renderToStaticMarkup(React.createElement(MainTemplate, {
    title: `UNPKG - ${req.packageName}`,
    description: `The CDN for ${req.packageName}`,
    data,
    content,
    elements
  }));
  res.set({
    'Cache-Control': 'public, max-age=14400',
    // 4 hours
    'Cache-Tag': 'browse'
  }).send(html);
}

var serveBrowsePage$1 = asyncHandler(serveBrowsePage);

async function findMatchingEntries(stream, filename) {
  // filename = /some/dir/name
  return new Promise((accept, reject) => {
    const entries = {};
    stream.pipe(tar.extract()).on('error', reject).on('entry', async (header, stream, next) => {
      const entry = {
        // Most packages have header names that look like `package/index.js`
        // so we shorten that to just `/index.js` here. A few packages use a
        // prefix other than `package/`. e.g. the firebase package uses the
        // `firebase_npm/` prefix. So we just strip the first dir name.
        path: header.name.replace(/^[^/]+\/?/, '/'),
        type: header.type
      }; // Dynamically create "directory" entries for all subdirectories
      // in this entry's path. Some tarballs omit directory entries for
      // some reason, so this is the "brute force" method.

      let dir = path.dirname(entry.path);

      while (dir !== '/') {
        if (!entries[dir] && path.dirname(dir) === filename) {
          entries[dir] = {
            path: dir,
            type: 'directory'
          };
        }

        dir = path.dirname(dir);
      } // Ignore non-files and files that aren't in this directory.


      if (entry.type !== 'file' || path.dirname(entry.path) !== filename) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      try {
        const content = await bufferStream(stream);
        entry.contentType = getContentType(entry.path);
        entry.integrity = getIntegrity(content);
        entry.size = content.length;
        entries[entry.path] = entry;
        next();
      } catch (error) {
        next(error);
      }
    }).on('finish', () => {
      accept(entries);
    });
  });
}

async function serveDirectoryBrowser(req, res) {
  const stream = await getPackage(req.packageName, req.packageVersion, req.log);
  const filename = req.filename.slice(0, -1) || '/';
  const entries = await findMatchingEntries(stream, filename);

  if (Object.keys(entries).length === 0) {
    return res.status(404).send(`Not found: ${req.packageSpec}${req.filename}`);
  }

  req.browseTarget = {
    path: filename,
    type: 'directory',
    details: entries
  };
  serveBrowsePage$1(req, res);
}

var serveDirectoryBrowser$1 = asyncHandler(serveDirectoryBrowser);

async function findMatchingEntries$1(stream, filename) {
  // filename = /some/dir/name
  return new Promise((accept, reject) => {
    const entries = {};
    entries[filename] = {
      path: filename,
      type: 'directory'
    };
    stream.pipe(tar.extract()).on('error', reject).on('entry', async (header, stream, next) => {
      const entry = {
        // Most packages have header names that look like `package/index.js`
        // so we shorten that to just `/index.js` here. A few packages use a
        // prefix other than `package/`. e.g. the firebase package uses the
        // `firebase_npm/` prefix. So we just strip the first dir name.
        path: header.name.replace(/^[^/]+\/?/, '/'),
        type: header.type
      }; // Dynamically create "directory" entries for all subdirectories
      // in this entry's path. Some tarballs omit directory entries for
      // some reason, so this is the "brute force" method.

      let dir = path.dirname(entry.path);

      while (dir !== '/') {
        if (!entries[dir] && dir.startsWith(filename)) {
          entries[dir] = {
            path: dir,
            type: 'directory'
          };
        }

        dir = path.dirname(dir);
      } // Ignore non-files and files that don't match the prefix.


      if (entry.type !== 'file' || !entry.path.startsWith(filename)) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      try {
        const content = await bufferStream(stream);
        entry.contentType = getContentType(entry.path);
        entry.integrity = getIntegrity(content);
        entry.lastModified = header.mtime.toUTCString();
        entry.size = content.length;
        entries[entry.path] = entry;
        next();
      } catch (error) {
        next(error);
      }
    }).on('finish', () => {
      accept(entries);
    });
  });
}

function getMatchingEntries(entry, entries) {
  return Object.keys(entries).filter(key => entry.path !== key && path.dirname(key) === entry.path).map(key => entries[key]);
}

function getMetadata(entry, entries) {
  const metadata = {
    path: entry.path,
    type: entry.type
  };

  if (entry.type === 'file') {
    metadata.contentType = entry.contentType;
    metadata.integrity = entry.integrity;
    metadata.lastModified = entry.lastModified;
    metadata.size = entry.size;
  } else if (entry.type === 'directory') {
    metadata.files = getMatchingEntries(entry, entries).map(e => getMetadata(e, entries));
  }

  return metadata;
}

async function serveDirectoryMetadata(req, res) {
  const stream = await getPackage(req.packageName, req.packageVersion, req.log);
  const filename = req.filename.slice(0, -1) || '/';
  const entries = await findMatchingEntries$1(stream, filename);
  const metadata = getMetadata(entries[filename], entries);
  res.send(metadata);
}

var serveDirectoryMetadata$1 = asyncHandler(serveDirectoryMetadata);

function createDataURI(contentType, content) {
  return `data:${contentType};base64,${content.toString('base64')}`;
}

function escapeHTML(code) {
  return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
} // These should probably be added to highlight.js auto-detection.


const extLanguages = {
  map: 'json',
  mjs: 'javascript',
  tsbuildinfo: 'json',
  tsx: 'typescript',
  txt: 'text',
  vue: 'html'
};

function getLanguage(file) {
  // Try to guess the language based on the file extension.
  const ext = path.extname(file).substr(1);

  if (ext) {
    return extLanguages[ext] || ext;
  }

  const contentType = getContentType(file);

  if (contentType === 'text/plain') {
    return 'text';
  }

  return null;
}

function getLines(code) {
  return code.split('\n').map((line, index, array) => index === array.length - 1 ? line : line + '\n');
}
/**
 * Returns an array of HTML strings that highlight the given source code.
 */


function getHighlights(code, file) {
  const language = getLanguage(file);

  if (!language) {
    return null;
  }

  if (language === 'text') {
    return getLines(code).map(escapeHTML);
  }

  try {
    let continuation = false;
    const hi = getLines(code).map(line => {
      const result = hljs.highlight(language, line, false, continuation);
      continuation = result.top;
      return result;
    });
    return hi.map(result => result.value.replace(/<span class="hljs-(\w+)">/g, '<span class="code-$1">'));
  } catch (error) {
    // Probably an "unknown language" error.
    // console.error(error);
    return null;
  }
}

const contentTypeNames = {
  'application/javascript': 'JavaScript',
  'application/json': 'JSON',
  'application/octet-stream': 'Binary',
  'application/vnd.ms-fontobject': 'Embedded OpenType',
  'application/xml': 'XML',
  'image/svg+xml': 'SVG',
  'font/ttf': 'TrueType Font',
  'font/woff': 'WOFF',
  'font/woff2': 'WOFF2',
  'text/css': 'CSS',
  'text/html': 'HTML',
  'text/jsx': 'JSX',
  'text/markdown': 'Markdown',
  'text/plain': 'Plain Text',
  'text/x-scss': 'SCSS',
  'text/yaml': 'YAML'
};
/**
 * Gets a human-friendly name for whatever is in the given file.
 */

function getLanguageName(file) {
  // Content-Type is text/plain, but we can be more descriptive.
  if (/\.flow$/.test(file)) return 'Flow';
  if (/\.(d\.ts|tsx)$/.test(file)) return 'TypeScript'; // Content-Type is application/json, but we can be more descriptive.

  if (/\.map$/.test(file)) return 'Source Map (JSON)';
  const contentType = getContentType(file);
  return contentTypeNames[contentType] || contentType;
}

async function findEntry(stream, filename) {
  // filename = /some/file/name.js
  return new Promise((accept, reject) => {
    let foundEntry = null;
    stream.pipe(tar.extract()).on('error', reject).on('entry', async (header, stream, next) => {
      const entry = {
        // Most packages have header names that look like `package/index.js`
        // so we shorten that to just `/index.js` here. A few packages use a
        // prefix other than `package/`. e.g. the firebase package uses the
        // `firebase_npm/` prefix. So we just strip the first dir name.
        path: header.name.replace(/^[^/]+\/?/, '/'),
        type: header.type
      }; // Ignore non-files and files that don't match the name.

      if (entry.type !== 'file' || entry.path !== filename) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      try {
        entry.content = await bufferStream(stream);
        foundEntry = entry;
        next();
      } catch (error) {
        next(error);
      }
    }).on('finish', () => {
      accept(foundEntry);
    });
  });
}

async function serveFileBrowser(req, res) {
  const stream = await getPackage(req.packageName, req.packageVersion, req.log);
  const entry = await findEntry(stream, req.filename);

  if (!entry) {
    return res.status(404).send(`Not found: ${req.packageSpec}${req.filename}`);
  }

  const details = {
    contentType: getContentType(entry.path),
    integrity: getIntegrity(entry.content),
    language: getLanguageName(entry.path),
    size: entry.content.length
  };

  if (/^image\//.test(details.contentType)) {
    details.uri = createDataURI(details.contentType, entry.content);
    details.highlights = null;
  } else {
    details.uri = null;
    details.highlights = getHighlights(entry.content.toString('utf8'), entry.path);
  }

  req.browseTarget = {
    path: req.filename,
    type: 'file',
    details
  };
  serveBrowsePage$1(req, res);
}

var serveFileBrowser$1 = asyncHandler(serveFileBrowser);

async function findEntry$1(stream, filename) {
  // filename = /some/file/name.js
  return new Promise((accept, reject) => {
    let foundEntry = null;
    stream.pipe(tar.extract()).on('error', reject).on('entry', async (header, stream, next) => {
      const entry = {
        // Most packages have header names that look like `package/index.js`
        // so we shorten that to just `/index.js` here. A few packages use a
        // prefix other than `package/`. e.g. the firebase package uses the
        // `firebase_npm/` prefix. So we just strip the first dir name.
        path: header.name.replace(/^[^/]+\/?/, '/'),
        type: header.type
      }; // Ignore non-files and files that don't match the name.

      if (entry.type !== 'file' || entry.path !== filename) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      try {
        const content = await bufferStream(stream);
        entry.contentType = getContentType(entry.path);
        entry.integrity = getIntegrity(content);
        entry.lastModified = header.mtime.toUTCString();
        entry.size = content.length;
        foundEntry = entry;
        next();
      } catch (error) {
        next(error);
      }
    }).on('finish', () => {
      accept(foundEntry);
    });
  });
}

async function serveFileMetadata(req, res) {
  const stream = await getPackage(req.packageName, req.packageVersion, req.log);
  const entry = await findEntry$1(stream, req.filename);

  res.send(entry);
}

var serveFileMetadata$1 = asyncHandler(serveFileMetadata);

function getContentTypeHeader(type) {
  return type === 'application/javascript' ? type + '; charset=utf-8' : type;
}

function serveFile(req, res) {
  const tags = ['file'];
  const ext = path.extname(req.entry.path).substr(1);

  if (ext) {
    tags.push(`${ext}-file`);
  }

  res.set({
    'Content-Type': getContentTypeHeader(req.entry.contentType),
    'Content-Length': req.entry.size,
    'Cache-Control': 'public, max-age=31536000',
    // 1 year
    'Last-Modified': req.entry.lastModified,
    ETag: etag(req.entry.content),
    'Cache-Tag': tags.join(', ')
  }).send(req.entry.content);
}

var MILLISECONDS_IN_MINUTE = 60000;

/**
 * Google Chrome as of 67.0.3396.87 introduced timezones with offset that includes seconds.
 * They usually appear for dates that denote time before the timezones were introduced
 * (e.g. for 'Europe/Prague' timezone the offset is GMT+00:57:44 before 1 October 1891
 * and GMT+01:00:00 after that date)
 *
 * Date#getTimezoneOffset returns the offset in minutes and would return 57 for the example above,
 * which would lead to incorrect calculations.
 *
 * This function returns the timezone offset in milliseconds that takes seconds in account.
 */
var getTimezoneOffsetInMilliseconds = function getTimezoneOffsetInMilliseconds (dirtyDate) {
  var date = new Date(dirtyDate.getTime());
  var baseTimezoneOffset = date.getTimezoneOffset();
  date.setSeconds(0, 0);
  var millisecondsPartOfTimezoneOffset = date.getTime() % MILLISECONDS_IN_MINUTE;

  return baseTimezoneOffset * MILLISECONDS_IN_MINUTE + millisecondsPartOfTimezoneOffset
};

/**
 * @category Common Helpers
 * @summary Is the given argument an instance of Date?
 *
 * @description
 * Is the given argument an instance of Date?
 *
 * @param {*} argument - the argument to check
 * @returns {Boolean} the given argument is an instance of Date
 *
 * @example
 * // Is 'mayonnaise' a Date?
 * var result = isDate('mayonnaise')
 * //=> false
 */
function isDate (argument) {
  return argument instanceof Date
}

var is_date = isDate;

var MILLISECONDS_IN_HOUR = 3600000;
var MILLISECONDS_IN_MINUTE$1 = 60000;
var DEFAULT_ADDITIONAL_DIGITS = 2;

var parseTokenDateTimeDelimeter = /[T ]/;
var parseTokenPlainTime = /:/;

// year tokens
var parseTokenYY = /^(\d{2})$/;
var parseTokensYYY = [
  /^([+-]\d{2})$/, // 0 additional digits
  /^([+-]\d{3})$/, // 1 additional digit
  /^([+-]\d{4})$/ // 2 additional digits
];

var parseTokenYYYY = /^(\d{4})/;
var parseTokensYYYYY = [
  /^([+-]\d{4})/, // 0 additional digits
  /^([+-]\d{5})/, // 1 additional digit
  /^([+-]\d{6})/ // 2 additional digits
];

// date tokens
var parseTokenMM = /^-(\d{2})$/;
var parseTokenDDD = /^-?(\d{3})$/;
var parseTokenMMDD = /^-?(\d{2})-?(\d{2})$/;
var parseTokenWww = /^-?W(\d{2})$/;
var parseTokenWwwD = /^-?W(\d{2})-?(\d{1})$/;

// time tokens
var parseTokenHH = /^(\d{2}([.,]\d*)?)$/;
var parseTokenHHMM = /^(\d{2}):?(\d{2}([.,]\d*)?)$/;
var parseTokenHHMMSS = /^(\d{2}):?(\d{2}):?(\d{2}([.,]\d*)?)$/;

// timezone tokens
var parseTokenTimezone = /([Z+-].*)$/;
var parseTokenTimezoneZ = /^(Z)$/;
var parseTokenTimezoneHH = /^([+-])(\d{2})$/;
var parseTokenTimezoneHHMM = /^([+-])(\d{2}):?(\d{2})$/;

/**
 * @category Common Helpers
 * @summary Convert the given argument to an instance of Date.
 *
 * @description
 * Convert the given argument to an instance of Date.
 *
 * If the argument is an instance of Date, the function returns its clone.
 *
 * If the argument is a number, it is treated as a timestamp.
 *
 * If an argument is a string, the function tries to parse it.
 * Function accepts complete ISO 8601 formats as well as partial implementations.
 * ISO 8601: http://en.wikipedia.org/wiki/ISO_8601
 *
 * If all above fails, the function passes the given argument to Date constructor.
 *
 * @param {Date|String|Number} argument - the value to convert
 * @param {Object} [options] - the object with options
 * @param {0 | 1 | 2} [options.additionalDigits=2] - the additional number of digits in the extended year format
 * @returns {Date} the parsed date in the local time zone
 *
 * @example
 * // Convert string '2014-02-11T11:30:30' to date:
 * var result = parse('2014-02-11T11:30:30')
 * //=> Tue Feb 11 2014 11:30:30
 *
 * @example
 * // Parse string '+02014101',
 * // if the additional number of digits in the extended year format is 1:
 * var result = parse('+02014101', {additionalDigits: 1})
 * //=> Fri Apr 11 2014 00:00:00
 */
function parse (argument, dirtyOptions) {
  if (is_date(argument)) {
    // Prevent the date to lose the milliseconds when passed to new Date() in IE10
    return new Date(argument.getTime())
  } else if (typeof argument !== 'string') {
    return new Date(argument)
  }

  var options = dirtyOptions || {};
  var additionalDigits = options.additionalDigits;
  if (additionalDigits == null) {
    additionalDigits = DEFAULT_ADDITIONAL_DIGITS;
  } else {
    additionalDigits = Number(additionalDigits);
  }

  var dateStrings = splitDateString(argument);

  var parseYearResult = parseYear(dateStrings.date, additionalDigits);
  var year = parseYearResult.year;
  var restDateString = parseYearResult.restDateString;

  var date = parseDate(restDateString, year);

  if (date) {
    var timestamp = date.getTime();
    var time = 0;
    var offset;

    if (dateStrings.time) {
      time = parseTime(dateStrings.time);
    }

    if (dateStrings.timezone) {
      offset = parseTimezone(dateStrings.timezone) * MILLISECONDS_IN_MINUTE$1;
    } else {
      var fullTime = timestamp + time;
      var fullTimeDate = new Date(fullTime);

      offset = getTimezoneOffsetInMilliseconds(fullTimeDate);

      // Adjust time when it's coming from DST
      var fullTimeDateNextDay = new Date(fullTime);
      fullTimeDateNextDay.setDate(fullTimeDate.getDate() + 1);
      var offsetDiff =
        getTimezoneOffsetInMilliseconds(fullTimeDateNextDay) -
        getTimezoneOffsetInMilliseconds(fullTimeDate);
      if (offsetDiff > 0) {
        offset += offsetDiff;
      }
    }

    return new Date(timestamp + time + offset)
  } else {
    return new Date(argument)
  }
}

function splitDateString (dateString) {
  var dateStrings = {};
  var array = dateString.split(parseTokenDateTimeDelimeter);
  var timeString;

  if (parseTokenPlainTime.test(array[0])) {
    dateStrings.date = null;
    timeString = array[0];
  } else {
    dateStrings.date = array[0];
    timeString = array[1];
  }

  if (timeString) {
    var token = parseTokenTimezone.exec(timeString);
    if (token) {
      dateStrings.time = timeString.replace(token[1], '');
      dateStrings.timezone = token[1];
    } else {
      dateStrings.time = timeString;
    }
  }

  return dateStrings
}

function parseYear (dateString, additionalDigits) {
  var parseTokenYYY = parseTokensYYY[additionalDigits];
  var parseTokenYYYYY = parseTokensYYYYY[additionalDigits];

  var token;

  // YYYY or ±YYYYY
  token = parseTokenYYYY.exec(dateString) || parseTokenYYYYY.exec(dateString);
  if (token) {
    var yearString = token[1];
    return {
      year: parseInt(yearString, 10),
      restDateString: dateString.slice(yearString.length)
    }
  }

  // YY or ±YYY
  token = parseTokenYY.exec(dateString) || parseTokenYYY.exec(dateString);
  if (token) {
    var centuryString = token[1];
    return {
      year: parseInt(centuryString, 10) * 100,
      restDateString: dateString.slice(centuryString.length)
    }
  }

  // Invalid ISO-formatted year
  return {
    year: null
  }
}

function parseDate (dateString, year) {
  // Invalid ISO-formatted year
  if (year === null) {
    return null
  }

  var token;
  var date;
  var month;
  var week;

  // YYYY
  if (dateString.length === 0) {
    date = new Date(0);
    date.setUTCFullYear(year);
    return date
  }

  // YYYY-MM
  token = parseTokenMM.exec(dateString);
  if (token) {
    date = new Date(0);
    month = parseInt(token[1], 10) - 1;
    date.setUTCFullYear(year, month);
    return date
  }

  // YYYY-DDD or YYYYDDD
  token = parseTokenDDD.exec(dateString);
  if (token) {
    date = new Date(0);
    var dayOfYear = parseInt(token[1], 10);
    date.setUTCFullYear(year, 0, dayOfYear);
    return date
  }

  // YYYY-MM-DD or YYYYMMDD
  token = parseTokenMMDD.exec(dateString);
  if (token) {
    date = new Date(0);
    month = parseInt(token[1], 10) - 1;
    var day = parseInt(token[2], 10);
    date.setUTCFullYear(year, month, day);
    return date
  }

  // YYYY-Www or YYYYWww
  token = parseTokenWww.exec(dateString);
  if (token) {
    week = parseInt(token[1], 10) - 1;
    return dayOfISOYear(year, week)
  }

  // YYYY-Www-D or YYYYWwwD
  token = parseTokenWwwD.exec(dateString);
  if (token) {
    week = parseInt(token[1], 10) - 1;
    var dayOfWeek = parseInt(token[2], 10) - 1;
    return dayOfISOYear(year, week, dayOfWeek)
  }

  // Invalid ISO-formatted date
  return null
}

function parseTime (timeString) {
  var token;
  var hours;
  var minutes;

  // hh
  token = parseTokenHH.exec(timeString);
  if (token) {
    hours = parseFloat(token[1].replace(',', '.'));
    return (hours % 24) * MILLISECONDS_IN_HOUR
  }

  // hh:mm or hhmm
  token = parseTokenHHMM.exec(timeString);
  if (token) {
    hours = parseInt(token[1], 10);
    minutes = parseFloat(token[2].replace(',', '.'));
    return (hours % 24) * MILLISECONDS_IN_HOUR +
      minutes * MILLISECONDS_IN_MINUTE$1
  }

  // hh:mm:ss or hhmmss
  token = parseTokenHHMMSS.exec(timeString);
  if (token) {
    hours = parseInt(token[1], 10);
    minutes = parseInt(token[2], 10);
    var seconds = parseFloat(token[3].replace(',', '.'));
    return (hours % 24) * MILLISECONDS_IN_HOUR +
      minutes * MILLISECONDS_IN_MINUTE$1 +
      seconds * 1000
  }

  // Invalid ISO-formatted time
  return null
}

function parseTimezone (timezoneString) {
  var token;
  var absoluteOffset;

  // Z
  token = parseTokenTimezoneZ.exec(timezoneString);
  if (token) {
    return 0
  }

  // ±hh
  token = parseTokenTimezoneHH.exec(timezoneString);
  if (token) {
    absoluteOffset = parseInt(token[2], 10) * 60;
    return (token[1] === '+') ? -absoluteOffset : absoluteOffset
  }

  // ±hh:mm or ±hhmm
  token = parseTokenTimezoneHHMM.exec(timezoneString);
  if (token) {
    absoluteOffset = parseInt(token[2], 10) * 60 + parseInt(token[3], 10);
    return (token[1] === '+') ? -absoluteOffset : absoluteOffset
  }

  return 0
}

function dayOfISOYear (isoYear, week, day) {
  week = week || 0;
  day = day || 0;
  var date = new Date(0);
  date.setUTCFullYear(isoYear, 0, 4);
  var fourthOfJanuaryDay = date.getUTCDay() || 7;
  var diff = week * 7 + day + 1 - fourthOfJanuaryDay;
  date.setUTCDate(date.getUTCDate() + diff);
  return date
}

var parse_1 = parse;

/**
 * @category Year Helpers
 * @summary Return the start of a year for the given date.
 *
 * @description
 * Return the start of a year for the given date.
 * The result will be in the local timezone.
 *
 * @param {Date|String|Number} date - the original date
 * @returns {Date} the start of a year
 *
 * @example
 * // The start of a year for 2 September 2014 11:55:00:
 * var result = startOfYear(new Date(2014, 8, 2, 11, 55, 00))
 * //=> Wed Jan 01 2014 00:00:00
 */
function startOfYear (dirtyDate) {
  var cleanDate = parse_1(dirtyDate);
  var date = new Date(0);
  date.setFullYear(cleanDate.getFullYear(), 0, 1);
  date.setHours(0, 0, 0, 0);
  return date
}

var start_of_year = startOfYear;

/**
 * @category Day Helpers
 * @summary Return the start of a day for the given date.
 *
 * @description
 * Return the start of a day for the given date.
 * The result will be in the local timezone.
 *
 * @param {Date|String|Number} date - the original date
 * @returns {Date} the start of a day
 *
 * @example
 * // The start of a day for 2 September 2014 11:55:00:
 * var result = startOfDay(new Date(2014, 8, 2, 11, 55, 0))
 * //=> Tue Sep 02 2014 00:00:00
 */
function startOfDay (dirtyDate) {
  var date = parse_1(dirtyDate);
  date.setHours(0, 0, 0, 0);
  return date
}

var start_of_day = startOfDay;

var MILLISECONDS_IN_MINUTE$2 = 60000;
var MILLISECONDS_IN_DAY = 86400000;

/**
 * @category Day Helpers
 * @summary Get the number of calendar days between the given dates.
 *
 * @description
 * Get the number of calendar days between the given dates.
 *
 * @param {Date|String|Number} dateLeft - the later date
 * @param {Date|String|Number} dateRight - the earlier date
 * @returns {Number} the number of calendar days
 *
 * @example
 * // How many calendar days are between
 * // 2 July 2011 23:00:00 and 2 July 2012 00:00:00?
 * var result = differenceInCalendarDays(
 *   new Date(2012, 6, 2, 0, 0),
 *   new Date(2011, 6, 2, 23, 0)
 * )
 * //=> 366
 */
function differenceInCalendarDays (dirtyDateLeft, dirtyDateRight) {
  var startOfDayLeft = start_of_day(dirtyDateLeft);
  var startOfDayRight = start_of_day(dirtyDateRight);

  var timestampLeft = startOfDayLeft.getTime() -
    startOfDayLeft.getTimezoneOffset() * MILLISECONDS_IN_MINUTE$2;
  var timestampRight = startOfDayRight.getTime() -
    startOfDayRight.getTimezoneOffset() * MILLISECONDS_IN_MINUTE$2;

  // Round the number of days to the nearest integer
  // because the number of milliseconds in a day is not constant
  // (e.g. it's different in the day of the daylight saving time clock shift)
  return Math.round((timestampLeft - timestampRight) / MILLISECONDS_IN_DAY)
}

var difference_in_calendar_days = differenceInCalendarDays;

/**
 * @category Day Helpers
 * @summary Get the day of the year of the given date.
 *
 * @description
 * Get the day of the year of the given date.
 *
 * @param {Date|String|Number} date - the given date
 * @returns {Number} the day of year
 *
 * @example
 * // Which day of the year is 2 July 2014?
 * var result = getDayOfYear(new Date(2014, 6, 2))
 * //=> 183
 */
function getDayOfYear (dirtyDate) {
  var date = parse_1(dirtyDate);
  var diff = difference_in_calendar_days(date, start_of_year(date));
  var dayOfYear = diff + 1;
  return dayOfYear
}

var get_day_of_year = getDayOfYear;

/**
 * @category Week Helpers
 * @summary Return the start of a week for the given date.
 *
 * @description
 * Return the start of a week for the given date.
 * The result will be in the local timezone.
 *
 * @param {Date|String|Number} date - the original date
 * @param {Object} [options] - the object with options
 * @param {Number} [options.weekStartsOn=0] - the index of the first day of the week (0 - Sunday)
 * @returns {Date} the start of a week
 *
 * @example
 * // The start of a week for 2 September 2014 11:55:00:
 * var result = startOfWeek(new Date(2014, 8, 2, 11, 55, 0))
 * //=> Sun Aug 31 2014 00:00:00
 *
 * @example
 * // If the week starts on Monday, the start of the week for 2 September 2014 11:55:00:
 * var result = startOfWeek(new Date(2014, 8, 2, 11, 55, 0), {weekStartsOn: 1})
 * //=> Mon Sep 01 2014 00:00:00
 */
function startOfWeek (dirtyDate, dirtyOptions) {
  var weekStartsOn = dirtyOptions ? (Number(dirtyOptions.weekStartsOn) || 0) : 0;

  var date = parse_1(dirtyDate);
  var day = date.getDay();
  var diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;

  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date
}

var start_of_week = startOfWeek;

/**
 * @category ISO Week Helpers
 * @summary Return the start of an ISO week for the given date.
 *
 * @description
 * Return the start of an ISO week for the given date.
 * The result will be in the local timezone.
 *
 * ISO week-numbering year: http://en.wikipedia.org/wiki/ISO_week_date
 *
 * @param {Date|String|Number} date - the original date
 * @returns {Date} the start of an ISO week
 *
 * @example
 * // The start of an ISO week for 2 September 2014 11:55:00:
 * var result = startOfISOWeek(new Date(2014, 8, 2, 11, 55, 0))
 * //=> Mon Sep 01 2014 00:00:00
 */
function startOfISOWeek (dirtyDate) {
  return start_of_week(dirtyDate, {weekStartsOn: 1})
}

var start_of_iso_week = startOfISOWeek;

/**
 * @category ISO Week-Numbering Year Helpers
 * @summary Get the ISO week-numbering year of the given date.
 *
 * @description
 * Get the ISO week-numbering year of the given date,
 * which always starts 3 days before the year's first Thursday.
 *
 * ISO week-numbering year: http://en.wikipedia.org/wiki/ISO_week_date
 *
 * @param {Date|String|Number} date - the given date
 * @returns {Number} the ISO week-numbering year
 *
 * @example
 * // Which ISO-week numbering year is 2 January 2005?
 * var result = getISOYear(new Date(2005, 0, 2))
 * //=> 2004
 */
function getISOYear (dirtyDate) {
  var date = parse_1(dirtyDate);
  var year = date.getFullYear();

  var fourthOfJanuaryOfNextYear = new Date(0);
  fourthOfJanuaryOfNextYear.setFullYear(year + 1, 0, 4);
  fourthOfJanuaryOfNextYear.setHours(0, 0, 0, 0);
  var startOfNextYear = start_of_iso_week(fourthOfJanuaryOfNextYear);

  var fourthOfJanuaryOfThisYear = new Date(0);
  fourthOfJanuaryOfThisYear.setFullYear(year, 0, 4);
  fourthOfJanuaryOfThisYear.setHours(0, 0, 0, 0);
  var startOfThisYear = start_of_iso_week(fourthOfJanuaryOfThisYear);

  if (date.getTime() >= startOfNextYear.getTime()) {
    return year + 1
  } else if (date.getTime() >= startOfThisYear.getTime()) {
    return year
  } else {
    return year - 1
  }
}

var get_iso_year = getISOYear;

/**
 * @category ISO Week-Numbering Year Helpers
 * @summary Return the start of an ISO week-numbering year for the given date.
 *
 * @description
 * Return the start of an ISO week-numbering year,
 * which always starts 3 days before the year's first Thursday.
 * The result will be in the local timezone.
 *
 * ISO week-numbering year: http://en.wikipedia.org/wiki/ISO_week_date
 *
 * @param {Date|String|Number} date - the original date
 * @returns {Date} the start of an ISO year
 *
 * @example
 * // The start of an ISO week-numbering year for 2 July 2005:
 * var result = startOfISOYear(new Date(2005, 6, 2))
 * //=> Mon Jan 03 2005 00:00:00
 */
function startOfISOYear (dirtyDate) {
  var year = get_iso_year(dirtyDate);
  var fourthOfJanuary = new Date(0);
  fourthOfJanuary.setFullYear(year, 0, 4);
  fourthOfJanuary.setHours(0, 0, 0, 0);
  var date = start_of_iso_week(fourthOfJanuary);
  return date
}

var start_of_iso_year = startOfISOYear;

var MILLISECONDS_IN_WEEK = 604800000;

/**
 * @category ISO Week Helpers
 * @summary Get the ISO week of the given date.
 *
 * @description
 * Get the ISO week of the given date.
 *
 * ISO week-numbering year: http://en.wikipedia.org/wiki/ISO_week_date
 *
 * @param {Date|String|Number} date - the given date
 * @returns {Number} the ISO week
 *
 * @example
 * // Which week of the ISO-week numbering year is 2 January 2005?
 * var result = getISOWeek(new Date(2005, 0, 2))
 * //=> 53
 */
function getISOWeek (dirtyDate) {
  var date = parse_1(dirtyDate);
  var diff = start_of_iso_week(date).getTime() - start_of_iso_year(date).getTime();

  // Round the number of days to the nearest integer
  // because the number of milliseconds in a week is not constant
  // (e.g. it's different in the week of the daylight saving time clock shift)
  return Math.round(diff / MILLISECONDS_IN_WEEK) + 1
}

var get_iso_week = getISOWeek;

/**
 * @category Common Helpers
 * @summary Is the given date valid?
 *
 * @description
 * Returns false if argument is Invalid Date and true otherwise.
 * Invalid Date is a Date, whose time value is NaN.
 *
 * Time value of Date: http://es5.github.io/#x15.9.1.1
 *
 * @param {Date} date - the date to check
 * @returns {Boolean} the date is valid
 * @throws {TypeError} argument must be an instance of Date
 *
 * @example
 * // For the valid date:
 * var result = isValid(new Date(2014, 1, 31))
 * //=> true
 *
 * @example
 * // For the invalid date:
 * var result = isValid(new Date(''))
 * //=> false
 */
function isValid (dirtyDate) {
  if (is_date(dirtyDate)) {
    return !isNaN(dirtyDate)
  } else {
    throw new TypeError(toString.call(dirtyDate) + ' is not an instance of Date')
  }
}

var is_valid = isValid;

function buildDistanceInWordsLocale () {
  var distanceInWordsLocale = {
    lessThanXSeconds: {
      one: 'less than a second',
      other: 'less than {{count}} seconds'
    },

    xSeconds: {
      one: '1 second',
      other: '{{count}} seconds'
    },

    halfAMinute: 'half a minute',

    lessThanXMinutes: {
      one: 'less than a minute',
      other: 'less than {{count}} minutes'
    },

    xMinutes: {
      one: '1 minute',
      other: '{{count}} minutes'
    },

    aboutXHours: {
      one: 'about 1 hour',
      other: 'about {{count}} hours'
    },

    xHours: {
      one: '1 hour',
      other: '{{count}} hours'
    },

    xDays: {
      one: '1 day',
      other: '{{count}} days'
    },

    aboutXMonths: {
      one: 'about 1 month',
      other: 'about {{count}} months'
    },

    xMonths: {
      one: '1 month',
      other: '{{count}} months'
    },

    aboutXYears: {
      one: 'about 1 year',
      other: 'about {{count}} years'
    },

    xYears: {
      one: '1 year',
      other: '{{count}} years'
    },

    overXYears: {
      one: 'over 1 year',
      other: 'over {{count}} years'
    },

    almostXYears: {
      one: 'almost 1 year',
      other: 'almost {{count}} years'
    }
  };

  function localize (token, count, options) {
    options = options || {};

    var result;
    if (typeof distanceInWordsLocale[token] === 'string') {
      result = distanceInWordsLocale[token];
    } else if (count === 1) {
      result = distanceInWordsLocale[token].one;
    } else {
      result = distanceInWordsLocale[token].other.replace('{{count}}', count);
    }

    if (options.addSuffix) {
      if (options.comparison > 0) {
        return 'in ' + result
      } else {
        return result + ' ago'
      }
    }

    return result
  }

  return {
    localize: localize
  }
}

var build_distance_in_words_locale = buildDistanceInWordsLocale;

var commonFormatterKeys = [
  'M', 'MM', 'Q', 'D', 'DD', 'DDD', 'DDDD', 'd',
  'E', 'W', 'WW', 'YY', 'YYYY', 'GG', 'GGGG',
  'H', 'HH', 'h', 'hh', 'm', 'mm',
  's', 'ss', 'S', 'SS', 'SSS',
  'Z', 'ZZ', 'X', 'x'
];

function buildFormattingTokensRegExp (formatters) {
  var formatterKeys = [];
  for (var key in formatters) {
    if (formatters.hasOwnProperty(key)) {
      formatterKeys.push(key);
    }
  }

  var formattingTokens = commonFormatterKeys
    .concat(formatterKeys)
    .sort()
    .reverse();
  var formattingTokensRegExp = new RegExp(
    '(\\[[^\\[]*\\])|(\\\\)?' + '(' + formattingTokens.join('|') + '|.)', 'g'
  );

  return formattingTokensRegExp
}

var build_formatting_tokens_reg_exp = buildFormattingTokensRegExp;

function buildFormatLocale () {
  // Note: in English, the names of days of the week and months are capitalized.
  // If you are making a new locale based on this one, check if the same is true for the language you're working on.
  // Generally, formatted dates should look like they are in the middle of a sentence,
  // e.g. in Spanish language the weekdays and months should be in the lowercase.
  var months3char = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var monthsFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var weekdays2char = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var weekdays3char = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var weekdaysFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var meridiemUppercase = ['AM', 'PM'];
  var meridiemLowercase = ['am', 'pm'];
  var meridiemFull = ['a.m.', 'p.m.'];

  var formatters = {
    // Month: Jan, Feb, ..., Dec
    'MMM': function (date) {
      return months3char[date.getMonth()]
    },

    // Month: January, February, ..., December
    'MMMM': function (date) {
      return monthsFull[date.getMonth()]
    },

    // Day of week: Su, Mo, ..., Sa
    'dd': function (date) {
      return weekdays2char[date.getDay()]
    },

    // Day of week: Sun, Mon, ..., Sat
    'ddd': function (date) {
      return weekdays3char[date.getDay()]
    },

    // Day of week: Sunday, Monday, ..., Saturday
    'dddd': function (date) {
      return weekdaysFull[date.getDay()]
    },

    // AM, PM
    'A': function (date) {
      return (date.getHours() / 12) >= 1 ? meridiemUppercase[1] : meridiemUppercase[0]
    },

    // am, pm
    'a': function (date) {
      return (date.getHours() / 12) >= 1 ? meridiemLowercase[1] : meridiemLowercase[0]
    },

    // a.m., p.m.
    'aa': function (date) {
      return (date.getHours() / 12) >= 1 ? meridiemFull[1] : meridiemFull[0]
    }
  };

  // Generate ordinal version of formatters: M -> Mo, D -> Do, etc.
  var ordinalFormatters = ['M', 'D', 'DDD', 'd', 'Q', 'W'];
  ordinalFormatters.forEach(function (formatterToken) {
    formatters[formatterToken + 'o'] = function (date, formatters) {
      return ordinal(formatters[formatterToken](date))
    };
  });

  return {
    formatters: formatters,
    formattingTokensRegExp: build_formatting_tokens_reg_exp(formatters)
  }
}

function ordinal (number) {
  var rem100 = number % 100;
  if (rem100 > 20 || rem100 < 10) {
    switch (rem100 % 10) {
      case 1:
        return number + 'st'
      case 2:
        return number + 'nd'
      case 3:
        return number + 'rd'
    }
  }
  return number + 'th'
}

var build_format_locale = buildFormatLocale;

/**
 * @category Locales
 * @summary English locale.
 */
var en = {
  distanceInWords: build_distance_in_words_locale(),
  format: build_format_locale()
};

/**
 * @category Common Helpers
 * @summary Format the date.
 *
 * @description
 * Return the formatted date string in the given format.
 *
 * Accepted tokens:
 * | Unit                    | Token | Result examples                  |
 * |-------------------------|-------|----------------------------------|
 * | Month                   | M     | 1, 2, ..., 12                    |
 * |                         | Mo    | 1st, 2nd, ..., 12th              |
 * |                         | MM    | 01, 02, ..., 12                  |
 * |                         | MMM   | Jan, Feb, ..., Dec               |
 * |                         | MMMM  | January, February, ..., December |
 * | Quarter                 | Q     | 1, 2, 3, 4                       |
 * |                         | Qo    | 1st, 2nd, 3rd, 4th               |
 * | Day of month            | D     | 1, 2, ..., 31                    |
 * |                         | Do    | 1st, 2nd, ..., 31st              |
 * |                         | DD    | 01, 02, ..., 31                  |
 * | Day of year             | DDD   | 1, 2, ..., 366                   |
 * |                         | DDDo  | 1st, 2nd, ..., 366th             |
 * |                         | DDDD  | 001, 002, ..., 366               |
 * | Day of week             | d     | 0, 1, ..., 6                     |
 * |                         | do    | 0th, 1st, ..., 6th               |
 * |                         | dd    | Su, Mo, ..., Sa                  |
 * |                         | ddd   | Sun, Mon, ..., Sat               |
 * |                         | dddd  | Sunday, Monday, ..., Saturday    |
 * | Day of ISO week         | E     | 1, 2, ..., 7                     |
 * | ISO week                | W     | 1, 2, ..., 53                    |
 * |                         | Wo    | 1st, 2nd, ..., 53rd              |
 * |                         | WW    | 01, 02, ..., 53                  |
 * | Year                    | YY    | 00, 01, ..., 99                  |
 * |                         | YYYY  | 1900, 1901, ..., 2099            |
 * | ISO week-numbering year | GG    | 00, 01, ..., 99                  |
 * |                         | GGGG  | 1900, 1901, ..., 2099            |
 * | AM/PM                   | A     | AM, PM                           |
 * |                         | a     | am, pm                           |
 * |                         | aa    | a.m., p.m.                       |
 * | Hour                    | H     | 0, 1, ... 23                     |
 * |                         | HH    | 00, 01, ... 23                   |
 * |                         | h     | 1, 2, ..., 12                    |
 * |                         | hh    | 01, 02, ..., 12                  |
 * | Minute                  | m     | 0, 1, ..., 59                    |
 * |                         | mm    | 00, 01, ..., 59                  |
 * | Second                  | s     | 0, 1, ..., 59                    |
 * |                         | ss    | 00, 01, ..., 59                  |
 * | 1/10 of second          | S     | 0, 1, ..., 9                     |
 * | 1/100 of second         | SS    | 00, 01, ..., 99                  |
 * | Millisecond             | SSS   | 000, 001, ..., 999               |
 * | Timezone                | Z     | -01:00, +00:00, ... +12:00       |
 * |                         | ZZ    | -0100, +0000, ..., +1200         |
 * | Seconds timestamp       | X     | 512969520                        |
 * | Milliseconds timestamp  | x     | 512969520900                     |
 *
 * The characters wrapped in square brackets are escaped.
 *
 * The result may vary by locale.
 *
 * @param {Date|String|Number} date - the original date
 * @param {String} [format='YYYY-MM-DDTHH:mm:ss.SSSZ'] - the string of tokens
 * @param {Object} [options] - the object with options
 * @param {Object} [options.locale=enLocale] - the locale object
 * @returns {String} the formatted date string
 *
 * @example
 * // Represent 11 February 2014 in middle-endian format:
 * var result = format(
 *   new Date(2014, 1, 11),
 *   'MM/DD/YYYY'
 * )
 * //=> '02/11/2014'
 *
 * @example
 * // Represent 2 July 2014 in Esperanto:
 * var eoLocale = require('date-fns/locale/eo')
 * var result = format(
 *   new Date(2014, 6, 2),
 *   'Do [de] MMMM YYYY',
 *   {locale: eoLocale}
 * )
 * //=> '2-a de julio 2014'
 */
function format (dirtyDate, dirtyFormatStr, dirtyOptions) {
  var formatStr = dirtyFormatStr ? String(dirtyFormatStr) : 'YYYY-MM-DDTHH:mm:ss.SSSZ';
  var options = dirtyOptions || {};

  var locale = options.locale;
  var localeFormatters = en.format.formatters;
  var formattingTokensRegExp = en.format.formattingTokensRegExp;
  if (locale && locale.format && locale.format.formatters) {
    localeFormatters = locale.format.formatters;

    if (locale.format.formattingTokensRegExp) {
      formattingTokensRegExp = locale.format.formattingTokensRegExp;
    }
  }

  var date = parse_1(dirtyDate);

  if (!is_valid(date)) {
    return 'Invalid Date'
  }

  var formatFn = buildFormatFn(formatStr, localeFormatters, formattingTokensRegExp);

  return formatFn(date)
}

var formatters = {
  // Month: 1, 2, ..., 12
  'M': function (date) {
    return date.getMonth() + 1
  },

  // Month: 01, 02, ..., 12
  'MM': function (date) {
    return addLeadingZeros(date.getMonth() + 1, 2)
  },

  // Quarter: 1, 2, 3, 4
  'Q': function (date) {
    return Math.ceil((date.getMonth() + 1) / 3)
  },

  // Day of month: 1, 2, ..., 31
  'D': function (date) {
    return date.getDate()
  },

  // Day of month: 01, 02, ..., 31
  'DD': function (date) {
    return addLeadingZeros(date.getDate(), 2)
  },

  // Day of year: 1, 2, ..., 366
  'DDD': function (date) {
    return get_day_of_year(date)
  },

  // Day of year: 001, 002, ..., 366
  'DDDD': function (date) {
    return addLeadingZeros(get_day_of_year(date), 3)
  },

  // Day of week: 0, 1, ..., 6
  'd': function (date) {
    return date.getDay()
  },

  // Day of ISO week: 1, 2, ..., 7
  'E': function (date) {
    return date.getDay() || 7
  },

  // ISO week: 1, 2, ..., 53
  'W': function (date) {
    return get_iso_week(date)
  },

  // ISO week: 01, 02, ..., 53
  'WW': function (date) {
    return addLeadingZeros(get_iso_week(date), 2)
  },

  // Year: 00, 01, ..., 99
  'YY': function (date) {
    return addLeadingZeros(date.getFullYear(), 4).substr(2)
  },

  // Year: 1900, 1901, ..., 2099
  'YYYY': function (date) {
    return addLeadingZeros(date.getFullYear(), 4)
  },

  // ISO week-numbering year: 00, 01, ..., 99
  'GG': function (date) {
    return String(get_iso_year(date)).substr(2)
  },

  // ISO week-numbering year: 1900, 1901, ..., 2099
  'GGGG': function (date) {
    return get_iso_year(date)
  },

  // Hour: 0, 1, ... 23
  'H': function (date) {
    return date.getHours()
  },

  // Hour: 00, 01, ..., 23
  'HH': function (date) {
    return addLeadingZeros(date.getHours(), 2)
  },

  // Hour: 1, 2, ..., 12
  'h': function (date) {
    var hours = date.getHours();
    if (hours === 0) {
      return 12
    } else if (hours > 12) {
      return hours % 12
    } else {
      return hours
    }
  },

  // Hour: 01, 02, ..., 12
  'hh': function (date) {
    return addLeadingZeros(formatters['h'](date), 2)
  },

  // Minute: 0, 1, ..., 59
  'm': function (date) {
    return date.getMinutes()
  },

  // Minute: 00, 01, ..., 59
  'mm': function (date) {
    return addLeadingZeros(date.getMinutes(), 2)
  },

  // Second: 0, 1, ..., 59
  's': function (date) {
    return date.getSeconds()
  },

  // Second: 00, 01, ..., 59
  'ss': function (date) {
    return addLeadingZeros(date.getSeconds(), 2)
  },

  // 1/10 of second: 0, 1, ..., 9
  'S': function (date) {
    return Math.floor(date.getMilliseconds() / 100)
  },

  // 1/100 of second: 00, 01, ..., 99
  'SS': function (date) {
    return addLeadingZeros(Math.floor(date.getMilliseconds() / 10), 2)
  },

  // Millisecond: 000, 001, ..., 999
  'SSS': function (date) {
    return addLeadingZeros(date.getMilliseconds(), 3)
  },

  // Timezone: -01:00, +00:00, ... +12:00
  'Z': function (date) {
    return formatTimezone(date.getTimezoneOffset(), ':')
  },

  // Timezone: -0100, +0000, ... +1200
  'ZZ': function (date) {
    return formatTimezone(date.getTimezoneOffset())
  },

  // Seconds timestamp: 512969520
  'X': function (date) {
    return Math.floor(date.getTime() / 1000)
  },

  // Milliseconds timestamp: 512969520900
  'x': function (date) {
    return date.getTime()
  }
};

function buildFormatFn (formatStr, localeFormatters, formattingTokensRegExp) {
  var array = formatStr.match(formattingTokensRegExp);
  var length = array.length;

  var i;
  var formatter;
  for (i = 0; i < length; i++) {
    formatter = localeFormatters[array[i]] || formatters[array[i]];
    if (formatter) {
      array[i] = formatter;
    } else {
      array[i] = removeFormattingTokens(array[i]);
    }
  }

  return function (date) {
    var output = '';
    for (var i = 0; i < length; i++) {
      if (array[i] instanceof Function) {
        output += array[i](date, formatters);
      } else {
        output += array[i];
      }
    }
    return output
  }
}

function removeFormattingTokens (input) {
  if (input.match(/\[[\s\S]/)) {
    return input.replace(/^\[|]$/g, '')
  }
  return input.replace(/\\/g, '')
}

function formatTimezone (offset, delimeter) {
  delimeter = delimeter || '';
  var sign = offset > 0 ? '-' : '+';
  var absOffset = Math.abs(offset);
  var hours = Math.floor(absOffset / 60);
  var minutes = absOffset % 60;
  return sign + addLeadingZeros(hours, 2) + delimeter + addLeadingZeros(minutes, 2)
}

function addLeadingZeros (number, targetLength) {
  var output = Math.abs(number).toString();
  while (output.length < targetLength) {
    output = '0' + output;
  }
  return output
}

var format_1 = format;

function createIcon$1(Type, _ref) {
  var css = _ref.css,
      rest = _objectWithoutPropertiesLoose(_ref, ["css"]);

  return core.jsx(Type, _extends({
    css: _extends({}, css, {
      verticalAlign: 'text-bottom'
    })
  }, rest));
}

function TwitterIcon$1(props) {
  return createIcon$1(FaTwitter, props);
}
function GitHubIcon$1(props) {
  return createIcon$1(FaGithub, props);
}

var CloudflareLogo = "/_client/46bc46bc8accec6a.png";

var AngularLogo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPoAAAD6CAMAAAC/MqoPAAAAz1BMVEUAAADUBy/DDi7dAzDdAzDdAzDdAzDDDi7DDi7DDi7dAzDdAzDdAzDDDi7DDi7DDi7dAzDdAzDdAzDDDi7DDi7DDi7dAzDdAzDDDi7DDi7dAzDdAzDDDi7DDi7dAzDDDi7fEz3HHTvugZjhh5f97/L78PLqYn7////aaHz74OX44eXmQmTSSmL3wMvww8vhI0rLLEjyobHppbHdAzDDDi7jMlfOO1XoUnHWWW/50Nj00tjscYvdd4nwkaTllqT0sL7stL7hRGPXBjDWBi/FDS4+JsiBAAAARXRSTlMAMDAwj9///9+PIHDPz3AgEGC/v2AQUK+vUJ/v75+AgP////////////////////////9AQP//////////////////r6+TKVt1AAAH7ElEQVR4AezUtaHDUBTA0I9mZtx/zHDMWOY+nQ3U6AsAAAAAAAAAAAAA8Em+f9Ts/v3713TDVK7esh3tRr9xPV+d7iCMtCf9KU5SJcKzXOvonaIU313VmjZK7zRtKXtsY/qI1OlZ9rN7Jb2rlza9IHS0JfoSV9D0wlxboa8oElljO5HeTU/C2E6kC5heN7Yz6QKm143tTLqA6QXrYzub/pxeKmFsV2buQllxZQ3DcJZ1jwuMS7AYGmx84Jy97/+exjNGWLv+zvst+O7gKfnrha6Kna4/ethhq9wUvdIf99G7EV8407xp1zpHevTuff8JrqN//3H/8PgPG0/njx5/2Hg6f/T4w8bTj/bo3ahKNWjdXpC76ty7B/9vMXz9Qbic+0cTOGz2JanRChw94LC55svyvPDNd5VH7+zrQQc2zPORJ/bi5ekhD5t94/zLJoAcOHrEYTNs+pU+M/CAowccNmBl/m1zD646evxhQ7f4Tl96cvzRW1WHjVs3/7HfswY6emv+v0Vy/Yo+oOnUP5rVT1F8SUVPeTnz8/bMaZZV8ipr+J1GDSeiD3/RRyJ61HTW+2bImWoTifxFY3pLQp/+Tp9J6G2eDuZMtflx0mMFffEnfamgd0g6nzNk1vD0R8qcUWZN86BdKXNGmTXr5jknzBlp1gC/4YQ5I82aqPkuZDkjzZprAL0lyxlp1rQB+mNY/iqv3WuY/gSgx6qc0WZNB6DflDWstGbvAPSVKGfEWbM+Ono32UdPezAdmCZn1FkTERPlDJ81PP0WKH+TX7K3oPw2Qm8pckadNW2Efi7IGXnWXEfosSBn5FnTQej3+ZzRZ80DhL7ic0afNWuEfsbnjD5rTiNkfM7osyZi9pzOGX3WvIDoLTpn9FnTJul8zvBZw9NjOmf0WdNh6XzOLJZs1vD0R6qcGU9UWfMUoq9EOfPO+feirFlD9HuinMmcL4CsYZ9e+Kb5sGtMus730nxnH4mioXYhyZmNc95vJVlzDaO3JA1bfqXPJTXbxuiPFTkzdV/pfqbImicYPVa8ML75Tn+reHvsYPSbgpwZuu90PxJkzR2MvhLkTL+iDwRZsz4a+qZG163ovXx3W4AOjc+ZhavofslnTcQNz5l8/Is+ybms4em36Jx5537R/Xs6a26D9BadM9nv9ILOmjZIfwbnTNL9nd5L4ax5CdJjOGcW7ne6X8JZ0wHp9+HHpvJP+hx+hHoA0ldszkzdn3Q/Y7NmDdLP2JzJ/qYXbNacRuDQnBnufrVghGZNRA7Nmf4ufUBlDU9vkY9N5S59Tj5CtVk6mDMLt0v3SyhreHoMPjaN6+gT8BGqw9K5nBm6OrofAVmD0YEHmP/VeLJ6epHv7v/804t9Kyxnkm49vZdiWbNG6Tewhl24erpfYjV7N0JH5Uxe7qPPcyprInYXzAtjle+79PqQH/BPL+a1oJzJ9tMLKGvaMP0xkzNDt5/uR0zWPIHpsZ3+ri7f6+n7Q/69nd6h6UjO5OVl9HkOZA1PXyE5s3CX0f0SyZo1TSdyJh9fTp/kQNbg9IjImaG7nO5HRNZE9Iicyf6LXgBZw9NvWXMG2wB9etE3zZCjj/RFQz7AZDm4wvj0Qi825gw4W9Z0cPp9W86gm9ieXuitbDmDzpQ1a5x+ZsoZeHP+6cUye85ws2RNdEh6N8fXOyi9pc8ZImvaB6UnPD09KD3W5wyRNR09nW9YpmYV9Ed8zlg24Z9e8KaZaugzumgMu6HPGSJr7kaC6XOGyJpIsQs+Z/isuSaht4Jzpj+u3z+TPRsEZ01bQn8cmjOJ27N/9wrS0Kx5IqHHoTmzsdO3oVnT0dMtOVPa6XN71ijpq8CcmTo73c8Cs2atpxtyJguhF/asEdKjsJxJXAjdp2FZE2kWljObMPrWnjVC+q2gnCnD6HN71tBPL4am6RuOXEU3HroBXzTIA0xiOHIV3XjoUvLpxbA4IGcSF0r3aUDWdET0+wE5swmnbwOy5oGIvgr42FAZTp8HfK5oLaKf2XNm6sLpfmbPmtNINPvHhrIm9ML+uaJINXPOJK4J3afmrJHRW8aGzTfN6NvcWLNtHd362FQ2o8+tj1A6emz8duLUNaP7mfErjJ0D0DPDkTPQC+MjlI7+yJYziWtK96kta57K6Ctbzmya07e2rFnL6Ddsj01lc/rc9gh1N5LNlDNT15zuZ6asiXS7sDw2ZQS9sDxCXRPSW4acSRxB96kha9pC+mNDzmwY+taQNU+E9NjwKeiSoc8NH5fuXDW97NctcwzdF4O6za+avvrcnl3Y6A5DQRS+PzMzF5FUMO/139KSeJmONdLe08EIvsR29+e9Of3n1TkdyXt6kI1OvtPP00CbX12n3zZBNzw6Tr/MokTV0m36qo5SbTtO0/uHYAO8k79ulHfy143yTv66Ud6J183VO/G6uXonWDfeu1P56WdWN9478brhtZYlp6+a4VTVKTW9X4dbi1OJ6ed1/DwD78Tr5uqdeN1cvROvm6t34nVz9U68bq7eidfN1Tvxurl6J0A3h6rxb0yfELrxLTo/nd5ndDPwTj66AeOP359+YYfzDZffm74CWTfwTrxurt6J183VO/G6uXonXjdX78Tr5uqdeN1cvROvm6t3ctYNGN9+ffoAGG7XcPdy+t5aN+BxWvxjsat3InTz79E7PekWQPbeyV83qOG//7PI/mhZlmVZlmVZlmVZlmXZPZmSvHpA7pEOAAAAAElFTkSuQmCC";

function _templateObject$1() {
  var data = _taggedTemplateLiteralLoose(["\n  html {\n    box-sizing: border-box;\n  }\n  *,\n  *:before,\n  *:after {\n    box-sizing: inherit;\n  }\n\n  html,\n  body,\n  #root {\n    height: 100%;\n    margin: 0;\n  }\n\n  body {\n    ", "\n    font-size: 16px;\n    line-height: 1.5;\n    background: white;\n    color: black;\n  }\n\n  code {\n    ", "\n  }\n\n  dd,\n  ul {\n    margin-left: 0;\n    padding-left: 25px;\n  }\n\n  #root {\n    display: flex;\n    flex-direction: column;\n  }\n"]);

  _templateObject$1 = function _templateObject() {
    return data;
  };

  return data;
}
var globalStyles$1 = core.css(_templateObject$1(), fontSans, fontMono);
var linkStyle$2 = {
  color: '#0076ff',
  textDecoration: 'none',
  ':hover': {
    textDecoration: 'underline'
  }
};

function AboutLogo(_ref) {
  var children = _ref.children;
  return core.jsx("div", {
    css: {
      textAlign: 'center',
      flex: '1'
    }
  }, children);
}

function AboutLogoImage(props) {
  return core.jsx("img", _extends({}, props, {
    css: {
      maxWidth: '90%'
    }
  }));
}

function Stats(_ref2) {
  var data = _ref2.data;
  var totals = data.totals;
  var since = parse_1(totals.since);
  var until = parse_1(totals.until);
  return core.jsx("p", null, "From ", core.jsx("strong", null, format_1(since, 'MMM D')), " to", ' ', core.jsx("strong", null, format_1(until, 'MMM D')), " unpkg served", ' ', core.jsx("strong", null, formatNumber(totals.requests.all)), " requests and a total of ", core.jsx("strong", null, formatBytes(totals.bandwidth.all)), " of data to", ' ', core.jsx("strong", null, formatNumber(totals.uniques.all)), " unique visitors,", ' ', core.jsx("strong", null, formatPercent(totals.requests.cached / totals.requests.all, 2), "%"), ' ', "of which were served from the cache.");
}

function App$1() {
  // const [stats, setStats] = useState(
  var _useState = React.useState(typeof window === 'object' && window.localStorage && window.localStorage.savedStats ? JSON.parse(window.localStorage.savedStats) : null),
      stats = _useState[0];

  var hasStats = !!(stats && !stats.error); // const stringStats = JSON.stringify(stats);
  // useEffect(() => {
  //   window.localStorage.savedStats = stringStats;
  // }, [stringStats]);
  // useEffect(() => {
  //   fetch('/api/stats?period=last-month')
  //     .then(res => res.json())
  //     .then(setStats);
  // }, []);

  return core.jsx(React.Fragment, null, core.jsx("div", {
    css: {
      maxWidth: 740,
      margin: '0 auto',
      padding: '0 20px'
    }
  }, core.jsx(core.Global, {
    styles: globalStyles$1
  }), core.jsx("header", null, core.jsx("h1", {
    css: {
      textTransform: 'uppercase',
      textAlign: 'center',
      fontSize: '5em'
    }
  }, "unpkg"), core.jsx("p", null, "unpkg is a fast, global content delivery network for everything on", ' ', core.jsx("a", {
    href: "https://www.npmjs.com/",
    css: linkStyle$2
  }, "npm"), ". Use it to quickly and easily load any file from any package using a URL like:"), core.jsx("div", {
    css: {
      textAlign: 'center',
      backgroundColor: '#eee',
      margin: '2em 0',
      padding: '5px 0'
    }
  }, "unpkg.com/:package@:version/:file"), hasStats && core.jsx(Stats, {
    data: stats
  })), core.jsx("h3", {
    css: {
      fontSize: '1.6em'
    },
    id: "examples"
  }, "Examples"), core.jsx("p", null, "Using a fixed version:"), core.jsx("ul", null, core.jsx("li", null, core.jsx("a", {
    title: "react.production.min.js",
    href: "/react@16.7.0/umd/react.production.min.js",
    css: linkStyle$2
  }, "unpkg.com/react@16.7.0/umd/react.production.min.js")), core.jsx("li", null, core.jsx("a", {
    title: "react-dom.production.min.js",
    href: "/react-dom@16.7.0/umd/react-dom.production.min.js",
    css: linkStyle$2
  }, "unpkg.com/react-dom@16.7.0/umd/react-dom.production.min.js"))), core.jsx("p", null, "You may also use a", ' ', core.jsx("a", {
    title: "semver",
    href: "https://docs.npmjs.com/misc/semver",
    css: linkStyle$2
  }, "semver range"), ' ', "or a", ' ', core.jsx("a", {
    title: "tags",
    href: "https://docs.npmjs.com/cli/dist-tag",
    css: linkStyle$2
  }, "tag"), ' ', "instead of a fixed version number, or omit the version/tag entirely to use the ", core.jsx("code", null, "latest"), " tag."), core.jsx("ul", null, core.jsx("li", null, core.jsx("a", {
    title: "react.production.min.js",
    href: "/react@^16/umd/react.production.min.js",
    css: linkStyle$2
  }, "unpkg.com/react@^16/umd/react.production.min.js")), core.jsx("li", null, core.jsx("a", {
    title: "react.production.min.js",
    href: "/react/umd/react.production.min.js",
    css: linkStyle$2
  }, "unpkg.com/react/umd/react.production.min.js"))), core.jsx("p", null, "If you omit the file path (i.e. use a \u201Cbare\u201D URL), unpkg will serve the file specified by the ", core.jsx("code", null, "unpkg"), " field in", ' ', core.jsx("code", null, "package.json"), ", or fall back to ", core.jsx("code", null, "main"), "."), core.jsx("ul", null, core.jsx("li", null, core.jsx("a", {
    title: "jQuery",
    href: "/jquery",
    css: linkStyle$2
  }, "unpkg.com/jquery")), core.jsx("li", null, core.jsx("a", {
    title: "Three.js",
    href: "/three",
    css: linkStyle$2
  }, "unpkg.com/three"))), core.jsx("p", null, "Append a ", core.jsx("code", null, "/"), " at the end of a URL to view a listing of all the files in a package."), core.jsx("ul", null, core.jsx("li", null, core.jsx("a", {
    title: "Index of the react package",
    href: "/react/",
    css: linkStyle$2
  }, "unpkg.com/react/")), core.jsx("li", null, core.jsx("a", {
    title: "Index of the react-router package",
    href: "/react-router/",
    css: linkStyle$2
  }, "unpkg.com/react-router/"))), core.jsx("h3", {
    css: {
      fontSize: '1.6em'
    },
    id: "query-params"
  }, "Query Parameters"), core.jsx("dl", null, core.jsx("dt", null, core.jsx("code", null, "?meta")), core.jsx("dd", null, "Return metadata about any file in a package as JSON (e.g.", core.jsx("code", null, "/any/file?meta"), ")"), core.jsx("dt", null, core.jsx("code", null, "?module")), core.jsx("dd", null, "Expands all", ' ', core.jsx("a", {
    title: "bare import specifiers",
    href: "https://html.spec.whatwg.org/multipage/webappapis.html#resolve-a-module-specifier",
    css: linkStyle$2
  }, "\u201Cbare\u201D ", core.jsx("code", null, "import"), " specifiers"), ' ', "in JavaScript modules to unpkg URLs. This feature is", ' ', core.jsx("em", null, "very experimental"))), core.jsx("h3", {
    css: {
      fontSize: '1.6em'
    },
    id: "cache-behavior"
  }, "Cache Behavior"), core.jsx("p", null, "The CDN caches files based on their permanent URL, which includes the npm package version. This works because npm does not allow package authors to overwrite a package that has already been published with a different one at the same version number."), core.jsx("p", null, "Browsers are instructed (via the ", core.jsx("code", null, "Cache-Control"), " header) to cache assets indefinitely (1 year)."), core.jsx("p", null, "URLs that do not specify a package version number redirect to one that does. This is the ", core.jsx("code", null, "latest"), " version when no version is specified, or the ", core.jsx("code", null, "maxSatisfying"), " version when a", ' ', core.jsx("a", {
    title: "semver",
    href: "https://github.com/npm/node-semver",
    css: linkStyle$2
  }, "semver version"), ' ', "is given. Redirects are cached for 10 minutes at the CDN, 1 minute in browsers."), core.jsx("p", null, "If you want users to be able to use the latest version when you cut a new release, the best policy is to put the version number in the URL directly in your installation instructions. This will also load more quickly because we won't have to resolve the latest version and redirect them."), core.jsx("h3", {
    css: {
      fontSize: '1.6em'
    },
    id: "workflow"
  }, "Workflow"), core.jsx("p", null, "For npm package authors, unpkg relieves the burden of publishing your code to a CDN in addition to the npm registry. All you need to do is include your", ' ', core.jsx("a", {
    title: "UMD",
    href: "https://github.com/umdjs/umd",
    css: linkStyle$2
  }, "UMD"), ' ', "build in your npm package (not your repo, that's different!)."), core.jsx("p", null, "You can do this easily using the following setup:"), core.jsx("ul", null, core.jsx("li", null, "Add the ", core.jsx("code", null, "umd"), " (or ", core.jsx("code", null, "dist"), ") directory to your", ' ', core.jsx("code", null, ".gitignore"), " file"), core.jsx("li", null, "Add the ", core.jsx("code", null, "umd"), " directory to your", ' ', core.jsx("a", {
    title: "package.json files array",
    href: "https://docs.npmjs.com/files/package.json#files",
    css: linkStyle$2
  }, "files array"), ' ', "in ", core.jsx("code", null, "package.json")), core.jsx("li", null, "Use a build script to generate your UMD build in the", ' ', core.jsx("code", null, "umd"), " directory when you publish")), core.jsx("p", null, "That's it! Now when you ", core.jsx("code", null, "npm publish"), " you'll have a version available on unpkg as well."), core.jsx("h3", {
    css: {
      fontSize: '1.6em'
    },
    id: "about"
  }, "About"), core.jsx("p", null, "unpkg is an", ' ', core.jsx("a", {
    title: "unpkg on GitHub",
    href: "https://github.com/unpkg",
    css: linkStyle$2
  }, "open source"), ' ', "project built and maintained by", ' ', core.jsx("a", {
    title: "mjackson on Twitter",
    href: "https://twitter.com/mjackson",
    css: linkStyle$2
  }, "Michael Jackson"), ". unpkg is not affiliated with or supported by npm, Inc. in any way. Please do not contact npm for help with unpkg. Instead, please reach out to", ' ', core.jsx("a", {
    title: "unpkg on Twitter",
    href: "https://twitter.com/unpkg",
    css: linkStyle$2
  }, "@unpkg"), ' ', "with any questions or concerns."), core.jsx("p", null, "The unpkg CDN is powered by", ' ', core.jsx("a", {
    title: "Cloudflare",
    href: "https://www.cloudflare.com",
    css: linkStyle$2
  }, "Cloudflare"), ", one of the world's largest and fastest cloud network platforms.", ' ', hasStats && core.jsx("span", null, "In the past month, Cloudflare served over", ' ', core.jsx("strong", null, formatBytes(stats.totals.bandwidth.all)), " to", ' ', core.jsx("strong", null, formatNumber(stats.totals.uniques.all)), " unique unpkg users all over the world.")), core.jsx("div", {
    css: {
      margin: '4em 0',
      display: 'flex',
      justifyContent: 'center'
    }
  }, core.jsx(AboutLogo, null, core.jsx("a", {
    title: "Cloudflare",
    href: "https://www.cloudflare.com"
  }, core.jsx(AboutLogoImage, {
    src: CloudflareLogo,
    height: "100"
  })))), core.jsx("p", null, "The origin servers for unpkg are powered by", ' ', core.jsx("a", {
    title: "Google Cloud",
    href: "https://cloud.google.com/",
    css: linkStyle$2
  }, "Google Cloud"), ' ', "and made possible by a generous donation from the", ' ', core.jsx("a", {
    title: "Angular",
    href: "https://angular.io",
    css: linkStyle$2
  }, "Angular web framework"), ", one of the world's most popular libraries for building incredible user experiences on both desktop and mobile."), core.jsx("div", {
    css: {
      margin: '4em 0 0',
      display: 'flex',
      justifyContent: 'center'
    }
  }, core.jsx(AboutLogo, null, core.jsx("a", {
    title: "Angular",
    href: "https://angular.io"
  }, core.jsx(AboutLogoImage, {
    src: AngularLogo,
    width: "200"
  }))))), core.jsx("footer", {
    css: {
      marginTop: '5rem',
      background: 'black',
      color: '#aaa'
    }
  }, core.jsx("div", {
    css: {
      maxWidth: 740,
      padding: '10px 20px',
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, core.jsx("p", null, "\xA9 ", new Date().getFullYear(), " UNPKG"), core.jsx("p", {
    css: {
      fontSize: '1.5rem'
    }
  }, core.jsx("a", {
    title: "Twitter",
    href: "https://twitter.com/unpkg",
    css: {
      color: '#aaa',
      display: 'inline-block',
      ':hover': {
        color: 'white'
      }
    }
  }, core.jsx(TwitterIcon$1, null)), core.jsx("a", {
    title: "GitHub",
    href: "https://github.com/mjackson/unpkg",
    css: {
      color: '#aaa',
      display: 'inline-block',
      marginLeft: '1rem',
      ':hover': {
        color: 'white'
      }
    }
  }, core.jsx(GitHubIcon$1, null))))));
}

if (process.env.NODE_ENV !== 'production') {
  App$1.propTypes = {
    location: PropTypes.object,
    children: PropTypes.node
  };
}

const doctype$1 = '<!DOCTYPE html>';
const globalURLs$1 = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? {
  '@emotion/core': '/@emotion/core@10.0.6/dist/core.umd.min.js',
  react: '/react@16.8.6/umd/react.production.min.js',
  'react-dom': '/react-dom@16.8.6/umd/react-dom.production.min.js'
} : {
  '@emotion/core': '/@emotion/core@10.0.6/dist/core.umd.min.js',
  react: '/react@16.8.6/umd/react.development.js',
  'react-dom': '/react-dom@16.8.6/umd/react-dom.development.js'
};
function serveMainPage(req, res) {
  const content = createHTML$1(server$1.renderToString(React.createElement(App$1)));
  const elements = getScripts('main', 'iife', globalURLs$1);
  const html = doctype$1 + server$1.renderToStaticMarkup(React.createElement(MainTemplate, {
    content,
    elements
  }));
  res.set({
    'Cache-Control': 'public, max-age=14400',
    // 4 hours
    'Cache-Tag': 'main'
  }).send(html);
}

const bareIdentifierFormat = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/;

function isValidURL(value) {
  return URL.parseURL(value) != null;
}

function isProbablyURLWithoutProtocol(value) {
  return value.substr(0, 2) === '//';
}

function isAbsoluteURL(value) {
  return isValidURL(value) || isProbablyURLWithoutProtocol(value);
}

function isBareIdentifier(value) {
  return value.charAt(0) !== '.' && value.charAt(0) !== '/';
}

function rewriteValue(
/* StringLiteral */
node, origin, dependencies) {
  if (isAbsoluteURL(node.value)) {
    return;
  }

  if (isBareIdentifier(node.value)) {
    // "bare" identifier
    const match = bareIdentifierFormat.exec(node.value);
    const packageName = match[1];
    const file = match[2] || '';
    warning(dependencies[packageName], 'Missing version info for package "%s" in dependencies; falling back to "latest"', packageName);
    const version = dependencies[packageName] || 'latest';
    node.value = `${origin}/${packageName}@${version}${file}?module`;
  } else {
    // local path
    node.value = `${node.value}?module`;
  }
}

function unpkgRewrite(origin, dependencies = {}) {
  return {
    manipulateOptions(opts, parserOpts) {
      parserOpts.plugins.push('dynamicImport', 'exportDefaultFrom', 'exportNamespaceFrom', 'importMeta');
    },

    visitor: {
      CallExpression(path) {
        if (path.node.callee.type !== 'Import') {
          // Some other function call, not import();
          return;
        }

        rewriteValue(path.node.arguments[0], origin, dependencies);
      },

      ExportAllDeclaration(path) {
        rewriteValue(path.node.source, origin, dependencies);
      },

      ExportNamedDeclaration(path) {
        if (!path.node.source) {
          // This export has no "source", so it's probably
          // a local variable or function, e.g.
          // export { varName }
          // export const constName = ...
          // export function funcName() {}
          return;
        }

        rewriteValue(path.node.source, origin, dependencies);
      },

      ImportDeclaration(path) {
        rewriteValue(path.node.source, origin, dependencies);
      }

    }
  };
}

const origin = 'https://unpkg.com';
function rewriteBareModuleIdentifiers(code, packageConfig) {
  const dependencies = Object.assign({}, packageConfig.peerDependencies, packageConfig.dependencies);
  const options = {
    // Ignore .babelrc and package.json babel config
    // because we haven't installed dependencies so
    // we can't load plugins; see #84
    babelrc: false,
    // Make a reasonable attempt to preserve whitespace
    // from the original file. This ensures minified
    // .mjs stays minified; see #149
    retainLines: true,
    plugins: [unpkgRewrite(origin, dependencies)]
  };
  return babel.transform(code, options).code;
}

function serveHTMLModule(req, res) {
  try {
    const $ = cheerio.load(req.entry.content.toString('utf8'));
    $('script[type=module]').each((index, element) => {
      $(element).html(rewriteBareModuleIdentifiers($(element).html(), req.packageConfig));
    });
    const code = $.html();
    res.set({
      'Content-Length': Buffer.byteLength(code),
      'Content-Type': getContentTypeHeader(req.entry.contentType),
      'Cache-Control': 'public, max-age=31536000',
      // 1 year
      ETag: etag(code),
      'Cache-Tag': 'file, html-file, html-module'
    }).send(code);
  } catch (error) {
    console.error(error);
    const errorName = error.constructor.name;
    const errorMessage = error.message.replace(/^.*?\/unpkg-.+?\//, `/${req.packageSpec}/`);
    const codeFrame = error.codeFrame;
    const debugInfo = `${errorName}: ${errorMessage}\n\n${codeFrame}`;
    res.status(500).type('text').send(`Cannot generate module for ${req.packageSpec}${req.filename}\n\n${debugInfo}`);
  }
}

function serveJavaScriptModule(req, res) {
  try {
    const code = rewriteBareModuleIdentifiers(req.entry.content.toString('utf8'), req.packageConfig);
    res.set({
      'Content-Length': Buffer.byteLength(code),
      'Content-Type': getContentTypeHeader(req.entry.contentType),
      'Cache-Control': 'public, max-age=31536000',
      // 1 year
      ETag: etag(code),
      'Cache-Tag': 'file, js-file, js-module'
    }).send(code);
  } catch (error) {
    console.error(error);
    const errorName = error.constructor.name;
    const errorMessage = error.message.replace(/^.*?\/unpkg-.+?\//, `/${req.packageSpec}/`);
    const codeFrame = error.codeFrame;
    const debugInfo = `${errorName}: ${errorMessage}\n\n${codeFrame}`;
    res.status(500).type('text').send(`Cannot generate module for ${req.packageSpec}${req.filename}\n\n${debugInfo}`);
  }
}

function serveModule(req, res) {
  if (req.entry.contentType === 'application/javascript') {
    return serveJavaScriptModule(req, res);
  }

  if (req.entry.contentType === 'text/html') {
    return serveHTMLModule(req, res);
  }

  res.status(403).type('text').send('module mode is available only for JavaScript and HTML files');
}

const cloudflareURL = 'https://api.cloudflare.com/client/v4';
const cloudflareEmail = undefined;
const cloudflareKey = undefined;

if (process.env.NODE_ENV !== 'production') {
  // {
  //   throw new Error('Missing the $CLOUDFLARE_EMAIL environment variable');
  // }

  // {
  //   throw new Error('Missing the $CLOUDFLARE_KEY environment variable');
  // }
}

function get$1(path, headers) {
  return fetch(`${cloudflareURL}${path}`, {
    headers: Object.assign({}, headers, {
      'X-Auth-Email': cloudflareEmail,
      'X-Auth-Key': cloudflareKey
    })
  });
}

function getJSON(path, headers) {
  return get$1(path, headers).then(res => {
    return res.json();
  }).then(data => {
    if (!data.success) {
      console.error(`cloudflare.getJSON failed at ${path}`);
      console.error(data);
      throw new Error('Failed to getJSON from Cloudflare');
    }

    return data.result;
  });
}

function getZones(domains) {
  return Promise.all((Array.isArray(domains) ? domains : [domains]).map(domain => getJSON(`/zones?name=${domain}`))).then(results => results.reduce((memo, zones) => memo.concat(zones)));
}

function reduceResults(target, values) {
  Object.keys(values).forEach(key => {
    const value = values[key];

    if (typeof value === 'object' && value) {
      target[key] = reduceResults(target[key] || {}, value);
    } else if (typeof value === 'number') {
      target[key] = (target[key] || 0) + values[key];
    }
  });
  return target;
}

function getZoneAnalyticsDashboard(zones, since, until) {
  return Promise.all((Array.isArray(zones) ? zones : [zones]).map(zone => {
    return getJSON(`/zones/${zone.id}/analytics/dashboard?since=${since.toISOString()}&until=${until.toISOString()}`);
  })).then(results => results.reduce(reduceResults));
}

function extractPublicInfo(data) {
  return {
    since: data.since,
    until: data.until,
    requests: {
      all: data.requests.all,
      cached: data.requests.cached,
      country: data.requests.country,
      status: data.requests.http_status
    },
    bandwidth: {
      all: data.bandwidth.all,
      cached: data.bandwidth.cached,
      country: data.bandwidth.country
    },
    threats: {
      all: data.threats.all,
      country: data.threats.country
    },
    uniques: {
      all: data.uniques.all
    }
  };
}

const DomainNames = ['unpkg.com', 'npmcdn.com'];
async function getStats(since, until) {
  const zones = await getZones(DomainNames);
  const dashboard = await getZoneAnalyticsDashboard(zones, since, until);
  return {
    timeseries: dashboard.timeseries.map(extractPublicInfo),
    totals: extractPublicInfo(dashboard.totals)
  };
}

function serveStats(req, res) {
  let since, until;

  if (req.query.period) {
    switch (req.query.period) {
      case 'last-day':
        until = dateFns.startOfDay(new Date());
        since = dateFns.subDays(until, 1);
        break;

      case 'last-week':
        until = dateFns.startOfDay(new Date());
        since = dateFns.subDays(until, 7);
        break;

      case 'last-month':
      default:
        until = dateFns.startOfDay(new Date());
        since = dateFns.subDays(until, 30);
    }
  } else {
    until = req.query.until ? new Date(req.query.until) : dateFns.startOfDay(new Date());
    since = req.query.since ? new Date(req.query.since) : dateFns.subDays(until, 1);
  }

  if (isNaN(since.getTime())) {
    return res.status(403).send({
      error: '?since is not a valid date'
    });
  }

  if (isNaN(until.getTime())) {
    return res.status(403).send({
      error: '?until is not a valid date'
    });
  }

  if (until <= since) {
    return res.status(403).send({
      error: '?until date must come after ?since date'
    });
  }

  if (until >= new Date()) {
    return res.status(403).send({
      error: '?until must be a date in the past'
    });
  }

  getStats(since, until).then(stats => {
    res.set({
      'Cache-Control': 'public, max-age=3600',
      // 1 hour
      'Cache-Tag': 'stats'
    }).send(stats);
  }, error => {
    console.error(error);
    res.status(500).send({
      error: 'Unable to fetch stats'
    });
  });
}

function createSearch(query) {
  const keys = Object.keys(query).sort();
  const pairs = keys.reduce((memo, key) => memo.concat(query[key] == null || query[key] === '' ? key : `${key}=${encodeURIComponent(query[key])}`), []);
  return pairs.length ? `?${pairs.join('&')}` : '';
}

/**
 * Reject URLs with invalid query parameters to increase cache hit rates.
 */

function allowQuery(validKeys = []) {
  if (!Array.isArray(validKeys)) {
    validKeys = [validKeys];
  }

  return (req, res, next) => {
    const keys = Object.keys(req.query);

    if (!keys.every(key => validKeys.includes(key))) {
      const newQuery = keys.filter(key => validKeys.includes(key)).reduce((query, key) => {
        query[key] = req.query[key];
        return query;
      }, {});
      return res.redirect(302, req.baseUrl + req.path + createSearch(newQuery));
    }

    next();
  };
}

function createPackageURL(packageName, packageVersion, filename, query) {
  let url = `/${packageName}`;
  if (packageVersion) url += `@${packageVersion}`;
  if (filename) url += filename;
  if (query) url += createSearch(query);
  return url;
}

function fileRedirect(req, res, entry) {
  // Redirect to the file with the extension so it's
  // clear which file is being served.
  res.set({
    'Cache-Control': 'public, max-age=31536000',
    // 1 year
    'Cache-Tag': 'redirect, file-redirect'
  }).redirect(302, createPackageURL(req.packageName, req.packageVersion, entry.path, req.query));
}

function indexRedirect(req, res, entry) {
  // Redirect to the index file so relative imports
  // resolve correctly.
  res.set({
    'Cache-Control': 'public, max-age=31536000',
    // 1 year
    'Cache-Tag': 'redirect, index-redirect'
  }).redirect(302, createPackageURL(req.packageName, req.packageVersion, entry.path, req.query));
}
/**
 * Search the given tarball for entries that match the given name.
 * Follows node's resolution algorithm.
 * https://nodejs.org/api/modules.html#modules_all_together
 */


function searchEntries(stream, filename) {
  // filename = /some/file/name.js or /some/dir/name
  return new Promise((accept, reject) => {
    const jsEntryFilename = `${filename}.js`;
    const jsonEntryFilename = `${filename}.json`;
    const matchingEntries = {};
    let foundEntry;

    if (filename === '/') {
      foundEntry = matchingEntries['/'] = {
        name: '/',
        type: 'directory'
      };
    }

    stream.pipe(tar.extract()).on('error', reject).on('entry', async (header, stream, next) => {
      const entry = {
        // Most packages have header names that look like `package/index.js`
        // so we shorten that to just `index.js` here. A few packages use a
        // prefix other than `package/`. e.g. the firebase package uses the
        // `firebase_npm/` prefix. So we just strip the first dir name.
        path: header.name.replace(/^[^/]+/g, ''),
        type: header.type
      }; // Skip non-files and files that don't match the entryName.

      if (entry.type !== 'file' || !entry.path.startsWith(filename)) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      matchingEntries[entry.path] = entry; // Dynamically create "directory" entries for all directories
      // that are in this file's path. Some tarballs omit these entries
      // for some reason, so this is the "brute force" method.

      let dir = path.dirname(entry.path);

      while (dir !== '/') {
        if (!matchingEntries[dir]) {
          matchingEntries[dir] = {
            name: dir,
            type: 'directory'
          };
        }

        dir = path.dirname(dir);
      }

      if (entry.path === filename || // Allow accessing e.g. `/index.js` or `/index.json`
      // using `/index` for compatibility with npm
      entry.path === jsEntryFilename || entry.path === jsonEntryFilename) {
        if (foundEntry) {
          if (foundEntry.path !== filename && (entry.path === filename || entry.path === jsEntryFilename && foundEntry.path === jsonEntryFilename)) {
            // This entry is higher priority than the one
            // we already found. Replace it.
            delete foundEntry.content;
            foundEntry = entry;
          }
        } else {
          foundEntry = entry;
        }
      }

      try {
        const content = await bufferStream(stream);
        entry.contentType = getContentType(entry.path);
        entry.integrity = getIntegrity(content);
        entry.lastModified = header.mtime.toUTCString();
        entry.size = content.length; // Set the content only for the foundEntry and
        // discard the buffer for all others.

        if (entry === foundEntry) {
          entry.content = content;
        }

        next();
      } catch (error) {
        next(error);
      }
    }).on('finish', () => {
      accept({
        // If we didn't find a matching file entry,
        // try a directory entry with the same name.
        foundEntry: foundEntry || matchingEntries[filename] || null,
        matchingEntries: matchingEntries
      });
    });
  });
}
/**
 * Fetch and search the archive to try and find the requested file.
 * Redirect to the "index" file if a directory was requested.
 */


async function findEntry$2(req, res, next) {
  const stream = await getPackage(req.packageName, req.packageVersion, req.log);
  const {
    foundEntry: entry,
    matchingEntries: entries
  } = await searchEntries(stream, req.filename);

  if (!entry) {
    return res.status(404).set({
      'Cache-Control': 'public, max-age=31536000',
      // 1 year
      'Cache-Tag': 'missing, missing-entry'
    }).type('text').send(`Cannot find "${req.filename}" in ${req.packageSpec}`);
  }

  if (entry.type === 'file' && entry.path !== req.filename) {
    return fileRedirect(req, res, entry);
  }

  if (entry.type === 'directory') {
    // We need to redirect to some "index" file inside the directory so
    // our URLs work in a similar way to require("lib") in node where it
    // uses `lib/index.js` when `lib` is a directory.
    const indexEntry = entries[`${req.filename}/index.js`] || entries[`${req.filename}/index.json`];

    if (indexEntry && indexEntry.type === 'file') {
      return indexRedirect(req, res, indexEntry);
    }

    return res.status(404).set({
      'Cache-Control': 'public, max-age=31536000',
      // 1 year
      'Cache-Tag': 'missing, missing-index'
    }).type('text').send(`Cannot find an index in "${req.filename}" in ${req.packageSpec}`);
  }

  req.entry = entry;
  next();
}

var findEntry$3 = asyncHandler(findEntry$2);

/**
 * Strips all query params from the URL to increase cache hit rates.
 */
function noQuery() {
  return (req, res, next) => {
    const keys = Object.keys(req.query);

    if (keys.length) {
      return res.redirect(302, req.baseUrl + req.path);
    }

    next();
  };
}

/**
 * Redirect old URLs that we no longer support.
 */

function redirectLegacyURLs(req, res, next) {
  // Permanently redirect /_meta/path to /path?meta
  if (req.path.match(/^\/_meta\//)) {
    req.query.meta = '';
    return res.redirect(301, req.path.substr(6) + createSearch(req.query));
  } // Permanently redirect /path?json => /path?meta


  if (req.query.json != null) {
    delete req.query.json;
    req.query.meta = '';
    return res.redirect(301, req.path + createSearch(req.query));
  }

  next();
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const enableDebugging = process.env.DEBUG != null;

function noop() {}

function createLog(req) {
  const traceContext = req.headers['x-cloud-trace-context'];

  if (projectId && traceContext) {
    const [traceId, spanId] = traceContext.split('/');
    const trace = `projects/${projectId}/traces/${traceId}`;
    return {
      debug: enableDebugging ? (format, ...args) => {
        console.log(JSON.stringify({
          severity: 'DEBUG',
          'logging.googleapis.com/trace': trace,
          'logging.googleapis.com/spanId': spanId,
          message: util.format(format, ...args)
        }));
      } : noop,
      info: (format, ...args) => {
        console.log(JSON.stringify({
          severity: 'INFO',
          'logging.googleapis.com/trace': trace,
          'logging.googleapis.com/spanId': spanId,
          message: util.format(format, ...args)
        }));
      },
      error: (format, ...args) => {
        console.error(JSON.stringify({
          severity: 'ERROR',
          'logging.googleapis.com/trace': trace,
          'logging.googleapis.com/spanId': spanId,
          message: util.format(format, ...args)
        }));
      }
    };
  }

  return {
    debug: enableDebugging ? (format, ...args) => {
      console.log(util.format(format, ...args));
    } : noop,
    info: (format, ...args) => {
      console.log(util.format(format, ...args));
    },
    error: (format, ...args) => {
      console.error(util.format(format, ...args));
    }
  };
}

function requestLog(req, res, next) {
  req.log = createLog(req);
  next();
}

function filenameRedirect(req, res) {
  let filename;

  if (req.query.module != null) {
    // See https://github.com/rollup/rollup/wiki/pkg.module
    filename = req.packageConfig.module || req.packageConfig['jsnext:main'];

    if (!filename) {
      // https://nodejs.org/api/esm.html#esm_code_package_json_code_code_type_code_field
      if (req.packageConfig.type === 'module') {
        // Use whatever is in pkg.main or index.js
        filename = req.packageConfig.main || '/index.js';
      } else if (req.packageConfig.main && /\.mjs$/.test(req.packageConfig.main)) {
        // Use .mjs file in pkg.main
        filename = req.packageConfig.main;
      }
    }

    if (!filename) {
      return res.status(404).type('text').send(`Package ${req.packageSpec} does not contain an ES module`);
    }
  } else if (req.query.main && req.packageConfig[req.query.main] && typeof req.packageConfig[req.query.main] === 'string') {
    // Deprecated, see #63
    filename = req.packageConfig[req.query.main];
  } else if (req.packageConfig.unpkg && typeof req.packageConfig.unpkg === 'string') {
    filename = req.packageConfig.unpkg;
  } else if (req.packageConfig.browser && typeof req.packageConfig.browser === 'string') {
    // Deprecated, see #63
    filename = req.packageConfig.browser;
  } else {
    filename = req.packageConfig.main || '/index.js';
  } // Redirect to the exact filename so relative imports
  // and URLs resolve correctly.


  res.set({
    'Cache-Control': 'public, max-age=31536000',
    // 1 year
    'Cache-Tag': 'redirect, filename-redirect'
  }).redirect(302, createPackageURL(req.packageName, req.packageVersion, filename.replace(/^\/*/, '/'), req.query));
}
/**
 * Redirect to the exact filename if the request omits one.
 */


async function validateFilename(req, res, next) {
  if (!req.filename) {
    return filenameRedirect(req, res);
  }

  next();
}

const packagePathnameFormat = /^\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/;
function parsePackagePathname(pathname) {
  try {
    pathname = decodeURIComponent(pathname);
  } catch (error) {
    return null;
  }

  const match = packagePathnameFormat.exec(pathname); // Disallow invalid pathnames.

  if (match == null) return null;
  const packageName = match[1];
  const packageVersion = match[2] || 'latest';
  const filename = (match[3] || '').replace(/\/\/+/g, '/');
  return {
    // If the pathname is /@scope/name@version/file.js:
    packageName,
    // @scope/name
    packageVersion,
    // version
    packageSpec: `${packageName}@${packageVersion}`,
    // @scope/name@version
    filename // /file.js

  };
}

/**
 * Parse the pathname in the URL. Reject invalid URLs.
 */

function validatePackagePathname(req, res, next) {
  const parsed = parsePackagePathname(req.path);

  if (parsed == null) {
    return res.status(403).send({
      error: `Invalid URL: ${req.path}`
    });
  }

  req.packageName = parsed.packageName;
  req.packageVersion = parsed.packageVersion;
  req.packageSpec = parsed.packageSpec;
  req.filename = parsed.filename;
  next();
}

const hexValue = /^[a-f0-9]+$/i;

function isHash(value) {
  return value.length === 32 && hexValue.test(value);
}
/**
 * Reject requests for invalid npm package names.
 */


function validatePackageName(req, res, next) {
  if (isHash(req.packageName)) {
    return res.status(403).type('text').send(`Invalid package name "${req.packageName}" (cannot be a hash)`);
  }

  const errors = validateNpmPackageName(req.packageName).errors;

  if (errors) {
    const reason = errors.join(', ');
    return res.status(403).type('text').send(`Invalid package name "${req.packageName}" (${reason})`);
  }

  next();
}

function semverRedirect(req, res, newVersion) {
  res.set({
    'Cache-Control': 'public, s-maxage=600, max-age=60',
    // 10 mins on CDN, 1 min on clients
    'Cache-Tag': 'redirect, semver-redirect'
  }).redirect(302, req.baseUrl + createPackageURL(req.packageName, newVersion, req.filename, req.query));
}

async function resolveVersion(packageName, range, log) {
  const versionsAndTags = await getVersionsAndTags(packageName, log);

  if (versionsAndTags) {
    const {
      versions,
      tags
    } = versionsAndTags;

    if (range in tags) {
      range = tags[range];
    }

    return versions.includes(range) ? range : semver.maxSatisfying(versions, range);
  }

  return null;
}
/**
 * Check the package version/tag in the URL and make sure it's good. Also
 * fetch the package config and add it to req.packageConfig. Redirect to
 * the resolved version number if necessary.
 */


async function validateVersion(req, res, next) {
  const version = await resolveVersion(req.packageName, req.packageVersion, req.log);

  if (!version) {
    return res.status(404).type('text').send(`Cannot find package ${req.packageSpec}`);
  }

  if (version !== req.packageVersion) {
    return semverRedirect(req, res, version);
  }

  req.packageConfig = await getPackageConfig(req.packageName, req.packageVersion, req.log);

  if (!req.packageConfig) {
    return res.status(500).type('text').send(`Cannot get config for package ${req.packageSpec}`);
  }

  next();
}

var validatePackageVersion = asyncHandler(validateVersion);

function createApp(callback) {
  const app = express();
  callback(app);
  return app;
}

function createServer() {
  return createApp(app => {
    app.disable('x-powered-by');
    app.enable('trust proxy');
    app.enable('strict routing');

    if (process.env.NODE_ENV === 'development') {
      app.use(morgan('dev'));
    }

    app.use(cors());
    app.use(express.static('public', {
      maxAge: '1y'
    })); // Special startup request from App Engine
    // https://cloud.google.com/appengine/docs/standard/nodejs/how-instances-are-managed

    app.get('/_ah/start', (req, res) => {
      res.status(200).end();
    });
    app.use(requestLog);
    app.get('/', serveMainPage);
    app.get('/api/stats', serveStats);
    app.use(redirectLegacyURLs);
    app.use('/browse', createApp(app => {
      app.enable('strict routing');
      app.get('*/', noQuery(), validatePackagePathname, validatePackageName, validatePackageVersion, serveDirectoryBrowser$1);
      app.get('*', noQuery(), validatePackagePathname, validatePackageName, validatePackageVersion, serveFileBrowser$1);
    })); // We need to route in this weird way because Express
    // doesn't have a way to route based on query params.

    const metadataApp = createApp(app => {
      app.enable('strict routing');
      app.get('*/', allowQuery('meta'), validatePackagePathname, validatePackageName, validatePackageVersion, validateFilename, serveDirectoryMetadata$1);
      app.get('*', allowQuery('meta'), validatePackagePathname, validatePackageName, validatePackageVersion, validateFilename, serveFileMetadata$1);
    });
    app.use((req, res, next) => {
      if (req.query.meta != null) {
        metadataApp(req, res);
      } else {
        next();
      }
    }); // We need to route in this weird way because Express
    // doesn't have a way to route based on query params.

    const moduleApp = createApp(app => {
      app.enable('strict routing');
      app.get('*', allowQuery('module'), validatePackagePathname, validatePackageName, validatePackageVersion, validateFilename, findEntry$3, serveModule);
    });
    app.use((req, res, next) => {
      if (req.query.module != null) {
        moduleApp(req, res);
      } else {
        next();
      }
    }); // Send old */ requests to the new /browse UI.

    app.get('*/', (req, res) => {
      res.redirect(302, '/browse' + req.url);
    });
    app.get('*', noQuery(), validatePackagePathname, validatePackageName, validatePackageVersion, validateFilename, findEntry$3, serveFile);
  });
}

if (process.env.GAE_ENV === 'standard') {
  require('@google-cloud/trace-agent').start();
}
const server = createServer();
const port = process.env.PORT || '8088';
server.listen(port, () => {
  console.log('Server listening on port %s, Ctrl+C to quit', port);
});
