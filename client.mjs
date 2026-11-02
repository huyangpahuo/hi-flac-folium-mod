const SITE_ORIGIN = 'https://flac.music.hi.cn';
const API_URL = `${SITE_ORIGIN}/ajax.php`;
const MAX_CACHE_ENTRIES = 500;

const SITE_NOTICE_ZH = [
  '音源网站： https://flac.music.hi.cn/',
  '',
  '网站作者的说明：',
  '• 网站称音频及相关资源来自第三方搜索引擎和网络公开资源，版权归原作者及发行方所有。',
  '• 网站资源仅供个人学习、试听交流使用；如通过网站下载，请按其页面要求在 24 小时内自行删除，切勿用于商业用途。',
  '• 作者希望用户通过快手或快手极速版扫码助力获取下载口令；网站说明即使助力失败也可能获得口令，并要求不要传播口令。',
  '• 网站提示：无法获取口令时，可联系 tamg969@qq.com。',
  '',
  '本模组只接入歌曲搜索、在线试听地址和歌词，不提供下载按钮；不会代填口令、模拟助力或绕过网站验证。请尊重作品版权，并遵守网站当前页面要求。',
].join('\n');

const SITE_NOTICE_EN = [
  'Source website: https://flac.music.hi.cn/',
  'The site says its resources come from third-party search engines and public network sources; copyright remains with the original creators and publishers.',
  'The site limits use to personal learning and listening. If you download through the site, it asks you to delete files within 24 hours and not use them commercially.',
  'The site author asks visitors to use Kuaishou or Kuaishou Lite to scan a QR code and obtain a download passcode. The site says a code may still be shown if the assist fails and asks users not to share it.',
  'The site lists tamg969@qq.com for users who cannot obtain a code.',
  'This mod only provides search, streaming playback URLs and lyrics. It has no download feature and does not enter passcodes, simulate assists or bypass site verification.',
].join('\n');

function makeFormBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body.toString();
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : value == null ? fallback : String(value).trim();
}

function normalizeHttpUrl(value) {
  const url = asString(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url.startsWith('//') ? `https:${url}` : url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseDurationMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object' || raw.id == null) return null;
  const title = asString(raw.name ?? raw.title);
  if (!title) return null;
  const artist = asString(raw.artist);
  const song = {
    id: String(raw.id),
    title,
    artists: artist ? [artist] : [],
  };
  const album = asString(raw.album_name ?? raw.album);
  const coverUrl = normalizeHttpUrl(raw.pic_url ?? raw.coverUrl);
  const durationMs = parseDurationMs(raw.duration);
  if (album) song.album = album;
  if (coverUrl) song.coverUrl = coverUrl;
  if (durationMs !== undefined) song.durationMs = durationMs;
  return song;
}

function chooseQuality(minfo, quality) {
  if (!Array.isArray(minfo)) return null;
  const entries = minfo
    .filter((item) => item && typeof item === 'object' && asString(item.format))
    .map((item) => ({
      format: asString(item.format).toLowerCase(),
      bitrate: Number(item.bitrate) || 0,
    }))
    .filter((item) => item.bitrate > 0);

  const mp3 = entries.filter((item) => item.format === 'mp3').sort((a, b) => a.bitrate - b.bitrate);
  const flac = entries.filter((item) => item.format === 'flac').sort((a, b) => b.bitrate - a.bitrate);

  if (quality === 'lossless') return flac[0] ?? null;
  // The website does not expose reliable sample-rate / bit-depth metadata, so do not
  // claim that a FLAC result is Hi-Res audio.
  if (quality === 'hires') return null;
  if (quality === 'high') {
    return mp3.find((item) => item.bitrate >= 320) ?? mp3.at(-1) ?? flac[0] ?? null;
  }
  return mp3.find((item) => item.bitrate <= 128) ?? mp3[0] ?? flac[0] ?? null;
}

function createProvider(folium, platform) {
  const rawById = new Map();

  const remember = (raw) => {
    if (!raw || raw.id == null) return;
    const id = String(raw.id);
    rawById.delete(id);
    rawById.set(id, raw);
    while (rawById.size > MAX_CACHE_ENTRIES) {
      rawById.delete(rawById.keys().next().value);
    }
  };

  const request = async (action, params) => {
    const response = await folium.net.fetch(`${API_URL}?act=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
      body: makeFormBody(params),
      timeoutMs: 15000,
    });

    if (!response.ok) {
      throw new Error(`音源网站请求失败：HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = response.json();
    } catch {
      throw new Error('音源网站返回了无法识别的数据');
    }

    if (!payload || Number(payload.code) !== 0) {
      throw new Error(asString(payload?.msg, '音源网站暂时无法处理请求'));
    }
    return payload.data ?? null;
  };

  const fetchRawSong = async (id) => {
    const data = await request('song', { platform, id });
    const raw = Array.isArray(data?.list) ? data.list[0] : null;
    if (!raw) return null;
    remember(raw);
    return raw;
  };

  return {
    id: `hi-flac-${platform}`,
    displayName: platform === 'kuwo' ? '无损音乐聚合 · 酷我' : '无损音乐聚合 · 网易云',
    shortName: platform === 'kuwo' ? '聚合·酷我' : '聚合·网易云',

    async search(query, page) {
      const limit = Math.max(1, Math.min(50, Math.trunc(Number(page?.limit) || 20)));
      const offset = Math.max(0, Math.trunc(Number(page?.offset) || 0));
      const pageNumber = Math.floor(offset / limit) + 1;
      const skipped = offset % limit;
      const requestSize = Math.min(50, limit + skipped);
      const data = await request('search', {
        platform,
        keyword: query,
        page: pageNumber,
        size: requestSize,
      });

      const rows = Array.isArray(data?.list) ? data.list : [];
      rows.forEach(remember);
      const items = rows.slice(skipped, skipped + limit).map(normalizeTrack).filter(Boolean);
      // The public site itself stops offering another page when fewer than the requested
      // number of rows are returned. Its `total` field is not a reliable query-result count,
      // so follow the same rule instead of advertising phantom pages.
      const hasMore = rows.length >= requestSize && items.length > 0;
      return { items, hasMore };
    },

    async getSong(id) {
      const raw = rawById.get(String(id)) ?? await fetchRawSong(id);
      return normalizeTrack(raw);
    },

    async getAudioUrl(song, quality) {
      const raw = rawById.get(String(song.id)) ?? await fetchRawSong(song.id);
      if (!raw) return null;
      const selected = chooseQuality(raw.minfo, quality);
      if (!selected) return null;

      const data = await request('getUrl', {
        platform,
        songid: raw.id,
        format: selected.format,
        bitrate: selected.bitrate,
        time: raw.time,
        sign: raw.sign,
      });
      const url = normalizeHttpUrl(data?.url);
      return url ? { url } : null;
    },

    async getLyrics(song) {
      const raw = rawById.get(String(song.id)) ?? await fetchRawSong(song.id);
      if (!raw) return null;
      const data = await request('getLyric', {
        platform,
        songid: raw.id,
        time: raw.time,
        sign: raw.sign,
      });
      const text = typeof data === 'string' ? data : asString(data?.lrc ?? data?.lyric);
      if (!text) return null;
      return { main: { format: 'lrc', text } };
    },
  };
}

export default function activate(folium) {
  if (folium?.env?.context !== 'main') return undefined;
  if (!folium?.host?.folium || folium.host.folium.minor < 7) {
    folium?.log?.warn?.('无损音乐聚合源需要 Folium 1.7 或更新版本。');
    return undefined;
  }

  const registry = folium.experimental?.['omni.providers'];
  if (!registry || typeof registry.register !== 'function') {
    folium.log.warn('当前 Folia 版本没有开放 omni.providers，无法注册第三方音源。');
    return undefined;
  }

  const handles = [];
  try {
    handles.push(registry.register(createProvider(folium, 'kuwo')));
    handles.push(registry.register(createProvider(folium, 'wyy')));
    handles.push(folium.registries.settingsSections.register({
      id: 'website-notice',
      label: { 'zh-CN': '网站使用须知', en: 'Website notice' },
      description: { 'zh-CN': SITE_NOTICE_ZH, en: SITE_NOTICE_EN },
      settings: [{
        key: 'notice_acknowledged',
        type: 'boolean',
        label: {
          'zh-CN': '我已阅读并理解网站使用须知',
          en: 'I have read and understood the website notice',
        },
        description: { 'zh-CN': SITE_NOTICE_ZH, en: SITE_NOTICE_EN },
        defaultValue: false,
      }],
    }));
  } catch (error) {
    for (const handle of handles.reverse()) {
      try { handle?.unregister?.(); } catch { /* best-effort rollback */ }
    }
    folium.log.error('无损音乐聚合源注册失败', error);
    return undefined;
  }

  folium.log.info('已注册无损音乐聚合源：酷我、网易云。');
  return () => {
    for (const handle of handles.reverse()) {
      try { handle?.unregister?.(); } catch { /* host also removes registrations on stop */ }
    }
  };
}
