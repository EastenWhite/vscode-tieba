import axios from './axios'
import * as vscode from 'vscode';

interface ThreadItem {
  title: string, // 帖子的标题
  href: string, // 帖子的链接
}

// ---- 贴吧移动端 protobuf 接口 ----
// 旧版网页接口(Bigpipe)会被百度按 IP 灰度成新版前端页面, 解析必然失败, 因此统一改用移动端接口
const PB_FRS_API = 'http://tiebac.baidu.com/c/f/frs/page?cmd=301001' // 吧主题列表
const PB_PAGE_API = 'https://tiebac.baidu.com/c/f/pb/page?cmd=302001' // 帖子楼层(可一并返回楼中楼)
const PB_FLOOR_API = 'https://tiebac.baidu.com/c/f/pb/floor?cmd=302002' // 单个楼层下的楼中楼(分页)
const PB_BOUNDARY = '-*_r1999'
const PB_CLIENT_VERSION = '22.13.1.0' // 吧列表使用新版客户端版本
const PB_PAGE_CLIENT_VERSION = '12.64.1.1' // 楼层接口沿用旧版客户端版本
const PB_EMOTICON_URL = 'https://tb2.bdstatic.com/tb/editor/images/client/' // 贴吧表情地址前缀

interface PbField {
  field: number,
  wire: number,
  value: number | Buffer
}

// varint 编码(用到的数值均小于 2^53, 用 number 即可)
function pbVarint(n: number): Buffer {
  const bytes: number[] = []
  let value = n
  while(value >= 128) {
    bytes.push((value % 128) | 128)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return Buffer.from(bytes)
}

// 长度分隔字段(wire type 2)
function pbLenField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([pbVarint(field * 8 + 2), pbVarint(payload.length), payload])
}

// varint 字段(wire type 0)
function pbVarintField(field: number, value: number): Buffer {
  return Buffer.concat([pbVarint(field * 8), pbVarint(value)])
}

// 解析 protobuf, 只保留字段号/类型/值
function pbParse(buf: Buffer): PbField[] {
  const fields: PbField[] = []
  let i = 0
  while(i < buf.length) {
    let raw = 0
    let mul = 1
    while(true) {
      const byte = buf[i++]
      raw += (byte & 0x7f) * mul
      mul *= 128
      if(!(byte & 0x80)) {
        break
      }
    }
    const field = Math.floor(raw / 8)
    const wire = raw % 8
    let value: number | Buffer
    if(wire === 0) {
      let intValue = 0
      let m = 1
      while(true) {
        const byte = buf[i++]
        intValue += (byte & 0x7f) * m
        m *= 128
        if(!(byte & 0x80)) {
          break
        }
      }
      value = intValue
    } else if(wire === 2) {
      let length = 0
      let m = 1
      while(true) {
        const byte = buf[i++]
        length += (byte & 0x7f) * m
        m *= 128
        if(!(byte & 0x80)) {
          break
        }
      }
      value = buf.subarray(i, i + length)
      i += length
    } else if(wire === 1) {
      value = buf.subarray(i, i + 8)
      i += 8
    } else if(wire === 5) {
      value = buf.subarray(i, i + 4)
      i += 4
    } else {
      break
    }
    fields.push({ field, wire, value })
  }
  return fields
}

function pbOne(fields: PbField[], field: number): PbField | undefined {
  return fields.find(item => item.field === field)
}

function pbNumber(item?: PbField): number {
  return item && typeof item.value === 'number' ? item.value : 0
}

function pbString(item?: PbField): string {
  return item && Buffer.isBuffer(item.value) ? item.value.toString('utf8') : ''
}

// 公共请求参数
function pbCommon(version: string, bduss?: string): Buffer {
  const fields = [
    pbVarintField(1, 2), // _client_type: 2 = 移动端
    pbLenField(2, Buffer.from(version)) // _client_version
  ]
  if(bduss) {
    fields.push(pbLenField(10, Buffer.from(bduss))) // BDUSS
  }
  return Buffer.concat(fields)
}

// 发送移动端 protobuf 请求, 返回响应的顶层字段
async function pbRequest(api: string, data: Buffer): Promise<PbField[]> {
  const body = Buffer.concat([
    Buffer.from(`--${PB_BOUNDARY}\r\nContent-Disposition: form-data; name="data"; filename="file"\r\n\r\n`),
    pbLenField(1, data),
    Buffer.from(`\r\n--${PB_BOUNDARY}--\r\n`)
  ])
  const res = await axios.post(api, body, {
    headers: {
      host: 'tiebac.baidu.com',
      'x_bd_data_type': 'protobuf',
      'Content-Type': `multipart/form-data; boundary=${PB_BOUNDARY}`,
      'Content-Length': body.length
    },
    responseType: 'arraybuffer'
  })
  // 响应拦截器会把请求错误当作成功返回, 此时 res.data 为 undefined
  if(!res || !res.data) {
    throw new Error('贴吧接口请求失败')
  }
  return pbParse(Buffer.from(res.data))
}

// 解析响应中的 error 字段(errorno/message)
function pbError(top: PbField[]): { code: number, message: string } {
  const errorField = pbOne(top, 1)
  if(!errorField || !Buffer.isBuffer(errorField.value)) {
    return { code: 0, message: '' }
  }
  const error = pbParse(errorField.value)
  return {
    code: pbNumber(pbOne(error, 1)),
    message: pbString(pbOne(error, 2))
  }
}

// 从已保存的 cookie 中取出 BDUSS, 楼层接口携带楼中楼时需要登录态
function getBduss(): string {
  const cookie = String(axios.defaults.headers.cookie || '')
  const match = cookie.match(/BDUSS=([^;]+)/)
  return match ? match[1] : ''
}

// 图片碎片的地址: cdn_src / big_cdn_src / origin_src / src
function pbImageSrc(chunk: PbField[]): string {
  const src = pbString(pbOne(chunk, 8)) || pbString(pbOne(chunk, 9)) ||
    pbString(pbOne(chunk, 25)) || pbString(pbOne(chunk, 4))
  return src.replace(/^http:\/\//, 'https://')
}

// 用户碎片: name_show 优先, 其次是 name
function pbUser(item?: PbField): string {
  if(!item || !Buffer.isBuffer(item.value)) {
    return ''
  }
  const user = pbParse(item.value)
  return pbString(pbOne(user, 4)) || pbString(pbOne(user, 3))
}

// 内容碎片转成纯文本 + 图片/表情列表(正文使用)
function pbContent(fields: PbField[], contentField: number): { text: string, imageList: string[] } {
  const result = { text: '', imageList: [] as string[] }
  for(const field of fields) {
    if(field.field !== contentField || !Buffer.isBuffer(field.value)) {
      continue
    }
    const chunk = pbParse(field.value)
    const type = pbNumber(pbOne(chunk, 1))
    if(type === 3 || type === 20) { // 图片
      const src = pbImageSrc(chunk)
      if(src) {
        result.imageList.push(src)
      }
      continue
    }
    if(type === 2 || type === 11) { // 表情
      const name = pbString(pbOne(chunk, 2))
      if(name) {
        result.imageList.push(PB_EMOTICON_URL + name + '.png')
      }
      continue
    }
    result.text += pbString(pbOne(chunk, 2))
  }
  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 内容碎片转成 html(楼中楼使用, 前端通过 v-html 渲染)
function pbContentHtml(fields: PbField[]): string {
  let html = ''
  for(const field of fields) {
    if(field.field !== 2 || !Buffer.isBuffer(field.value)) {
      continue
    }
    const chunk = pbParse(field.value)
    const type = pbNumber(pbOne(chunk, 1))
    if(type === 3 || type === 20) { // 图片
      const src = pbImageSrc(chunk)
      if(src) {
        html += `<img class="comment-img" src="${src}" />`
      }
      continue
    }
    if(type === 2 || type === 11) { // 表情
      const name = pbString(pbOne(chunk, 2))
      if(name) {
        html += `<img src="${PB_EMOTICON_URL + name}.png" />`
      }
      continue
    }
    html += escapeHtml(pbString(pbOne(chunk, 2))).replace(/\r?\n/g, '<br/>')
  }
  return html
}

// 楼中楼(SubPost) => 前端使用的评论结构
function pbComment(subPost: PbField[], userMap: Record<string, string>): any {
  const authorId = String(pbNumber(pbOne(subPost, 4)))
  return {
    comment_id: String(pbNumber(pbOne(subPost, 1))),
    username: pbUser(pbOne(subPost, 7)) || userMap[authorId] || '',
    now_time: pbNumber(pbOne(subPost, 3)),
    content: pbContentHtml(subPost)
  }
}

// unix 秒 => YYYY-MM-DD HH:mm
function formatTime(seconds: number): string {
  if(!seconds) {
    return ''
  }
  const date = new Date(seconds * 1000)
  const pad = (n: number) => n < 10 ? '0' + n : String(n)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 取单个帖子的标题(部分吧被改造成分区化首页后, 吧列表不再下发 thread_list)
async function pbThreadTitle(tid: number): Promise<string> {
  const data = Buffer.concat([
    pbLenField(25, pbCommon(PB_CLIENT_VERSION, getBduss())), // common
    pbVarintField(4, tid), // kz: 主题id
    pbVarintField(13, 1), // rn: 只取一楼, 减少流量
    pbVarintField(18, 1) // pn: 第一页
  ])
  const top = await pbRequest(PB_PAGE_API, data)
  // rn 较小时服务端会返回 errno 29(楼层可能已被删除), 但主题信息仍然有效
  const dataField = pbOne(top, 2)
  if(!dataField || !Buffer.isBuffer(dataField.value)) {
    return ''
  }
  const threadField = pbOne(pbParse(dataField.value), 8)
  if(!threadField || !Buffer.isBuffer(threadField.value)) {
    return ''
  }
  return pbString(pbOne(pbParse(threadField.value), 3)).trim()
}

// 限制并发地取一批帖子的标题, 保持原有顺序
async function pbThreadTitles(ids: number[], limit: number = 6): Promise<ThreadItem[]> {
  const result: ThreadItem[] = new Array(ids.length)
  let cursor = 0
  const worker = async () => {
    while(cursor < ids.length) {
      const index = cursor++
      const tid = ids[index]
      const title = await pbThreadTitle(tid).catch(() => '')
      if(title) {
        result[index] = { title, href: `https://tieba.baidu.com/p/${tid}` }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, () => worker()))
  return result.filter(item => !!item)
}

// 营销推广帖(如直播间拉人)的标题特征: 用「·」拼接多段营销短语
// 例如 "560暴富厅·军团战队·等你进来·带你飞"
// 这类帖服务端并不下发 is_ad 标记, 只能按标题特征兜底, 词表按需补充
// 刻意只收录几乎只出现在推广文案里的词, 避免误杀正常帖
const AD_TITLE_KEYWORDS = ['暴富厅', '福利厅', '带你飞', '等你进来', '点击领取', '红包群']

function isAdThread(title: string): boolean {
  // 正常帖标题极少出现两个以上的「·」分隔(兼容 · • ・ 几种码点)
  if((title.match(/[·•・]/g) || []).length >= 2) {
    return true
  }
  return AD_TITLE_KEYWORDS.some(word => title.includes(word))
}

// 获取某个吧的帖子
export async function getThreadList(keyword: string = '高达模型'): Promise<ThreadItem[]> {
  const data = Buffer.concat([
    pbLenField(39, pbCommon(PB_CLIENT_VERSION)), // common
    pbLenField(1, Buffer.from(keyword)), // kw
    pbVarintField(2, 40), // rn: 请求数量(接口实际返回 rn-1 条)
    pbVarintField(3, 45), // rn_need: 实际返回数量(略大于 rn)
    pbVarintField(4, 0), // is_good: 是否只要精品
    pbVarintField(15, 0), // pn: 第一页
    pbVarintField(47, 0) // sort_type: 按回复时间排序
  ])
  try {
    const top = await pbRequest(PB_FRS_API, data)
    const error = pbError(top)
    if(error.code) {
      console.error('获取帖子列表失败, errorno:', error.code, error.message)
      vscode.window.showErrorMessage(`获取贴吧「${keyword}」帖子列表失败：${error.message || error.code}`)
      return []
    }
    const dataField = pbOne(top, 2)
    if(!dataField || !Buffer.isBuffer(dataField.value)) {
      return []
    }

    const threadList: ThreadItem[] = []
    let forumTids: number[] = []
    for(const item of pbParse(dataField.value)) {
      // forum 中的 field 20 是首页帖子的 tid 列表, 分区化的吧只下发这个
      if(item.field === 2 && Buffer.isBuffer(item.value)) {
        forumTids = pbString(pbOne(pbParse(item.value), 20))
          .split(',')
          .map(value => Number(value))
          .filter(value => value > 0)
        continue
      }
      if(item.field !== 7 || !Buffer.isBuffer(item.value)) {
        continue // thread_list
      }
      const thread = pbParse(item.value)
      if(pbNumber(pbOne(thread, 59))) {
        continue // is_ad: 屏蔽广告
      }
      const id = pbNumber(pbOne(thread, 1))
      const title = pbString(pbOne(thread, 3)).trim()
      if(!id || !title) {
        continue
      }
      if(isAdThread(title)) {
        continue // 屏蔽营销推广帖
      }
      threadList.push({
        title,
        href: `https://tieba.baidu.com/p/${id}`
      })
    }
    // 没有下发 thread_list 时, 用 forum 的 tid 列表逐个补标题
    if(!threadList.length && forumTids.length) {
      const fallbackList = await pbThreadTitles(forumTids.slice(0, 40))
      return fallbackList.filter(item => !isAdThread(item.title))
    }
    return threadList
  } catch(err) {
    console.error('获取帖子列表失败', err)
    vscode.window.showErrorMessage(`获取贴吧「${keyword}」帖子列表失败，请检查网络或 cookie`)
    return []
  }
}

export interface PostItem {
  text: string, // 文字内容
  author: string, // 作者
  pid: string, // postid, 用于对应评论
  imageList: string[], // 图片列表
  commentList?: any[], // 评论
  commentCount?: number, // 楼中楼总数
  field: any,
  date: string
}

// 获取一个帖子的内容
export async function getPostList(url: string = 'https://tieba.baidu.com/p/7029367562', page: number = 1, seeLz: boolean = false) {
  const tidMatch = url.match(/p\/(\d+)/)
  if(!tidMatch) {
    vscode.window.showErrorMessage('帖子链接无效')
    return { errMessage: '帖子链接无效' }
  }
  const tid = Number(tidMatch[1])
  const data = Buffer.concat([
    pbLenField(25, pbCommon(PB_CLIENT_VERSION, getBduss())), // common
    pbVarintField(4, tid), // kz: 主题id
    pbVarintField(5, seeLz ? 1 : 0), // lz: 只看楼主
    pbVarintField(8, 1), // with_floor: 一并返回楼中楼
    pbVarintField(9, 10), // floor_rn: 每层楼最多返回的楼中楼数量
    pbVarintField(13, 30), // rn: 每页楼层数
    pbVarintField(18, page), // pn: 页码, 第一页是 1
    pbVarintField(74, 0) // floor_sort_type: 楼中楼按时间正序
  ])
  try {
    const top = await pbRequest(PB_PAGE_API, data)
    const error = pbError(top)
    if(error.code) {
      console.error('获取帖子内容失败, errorno:', error.code, error.message)
      const message = error.message || '获取帖子内容失败'
      vscode.window.showErrorMessage(message)
      return { errMessage: message }
    }
    const dataField = pbOne(top, 2)
    if(!dataField || !Buffer.isBuffer(dataField.value)) {
      return { errMessage: '获取帖子内容失败' }
    }
    const dataFields = pbParse(dataField.value)

    let totalPost = 0
    let totalPage = 0
    // 回复数包含楼中楼, 与网页端显示的"回复贴"数量一致
    const threadField = pbOne(dataFields, 8)
    if(threadField && Buffer.isBuffer(threadField.value)) {
      totalPost = pbNumber(pbOne(pbParse(threadField.value), 4)) // reply_num
    }
    const pageField = pbOne(dataFields, 3)
    if(pageField && Buffer.isBuffer(pageField.value)) {
      const pageInfo = pbParse(pageField.value)
      totalPage = pbNumber(pbOne(pageInfo, 5)) // total_page
      if(!totalPost) {
        totalPost = pbNumber(pbOne(pageInfo, 4)) // total_count
      }
    }

    // 部分用户信息只在 user_list 中返回, 用 author_id 兜底
    const userMap: Record<string, string> = {}
    for(const field of dataFields) {
      if(field.field !== 13 || !Buffer.isBuffer(field.value)) {
        continue // user_list
      }
      const user = pbParse(field.value)
      userMap[String(pbNumber(pbOne(user, 2)))] = pbString(pbOne(user, 4)) || pbString(pbOne(user, 3))
    }

    const postList: PostItem[] = []
    for(const item of dataFields) {
      if(item.field !== 6 || !Buffer.isBuffer(item.value)) {
        continue // post_list
      }
      const post = pbParse(item.value)
      const pid = pbNumber(pbOne(post, 1))
      const postDate = pbNumber(pbOne(post, 4))
      const authorId = pbNumber(pbOne(post, 19))
      // 广告楼层不携带楼层元数据(pid/作者/时间), 对应旧版 data-field === '{}' 的判断
      if(!pid || !postDate || !authorId) {
        continue
      }
      const content = pbContent(post, 5)
      const author = pbUser(pbOne(post, 23)) || userMap[String(authorId)] || ''

      // 楼中楼: sub_post_list(15) -> sub_post_list(2)
      const commentList: any[] = []
      const subPostList = pbOne(post, 15)
      if(subPostList && Buffer.isBuffer(subPostList.value)) {
        for(const field of pbParse(subPostList.value)) {
          if(field.field !== 2 || !Buffer.isBuffer(field.value)) {
            continue
          }
          commentList.push(pbComment(pbParse(field.value), userMap))
        }
      }

      postList.push({
        text: content.text.trim(),
        author,
        imageList: content.imageList,
        pid: String(pid),
        field: {},
        date: formatTime(postDate),
        commentList,
        commentCount: pbNumber(pbOne(post, 13)) // 楼中楼总数
      })
    }

    return {
      postList,
      totalPost,
      totalPage
    }
  } catch(err) {
    console.error('获取帖子内容失败', err)
    const message = '获取帖子内容失败，请检查网络或 cookie'
    vscode.window.showErrorMessage(message)
    return { errMessage: message }
  }
}

// 获取某个楼层(pid)下的楼中楼, 每页 30 条
export async function getCommentList(url: string = '', pid: string = '', page: number = 1) {
  const tidMatch = url.match(/p\/(\d+)/)
  if(!tidMatch) {
    vscode.window.showErrorMessage('帖子链接无效')
    return { errMessage: '帖子链接无效' }
  }
  const tid = Number(tidMatch[1])
  const data = Buffer.concat([
    pbLenField(9, pbCommon(PB_CLIENT_VERSION, getBduss())), // common
    pbVarintField(1, tid), // kz: 主题id
    pbVarintField(2, Number(pid)), // pid: 楼层id
    pbVarintField(4, page) // pn: 页码, 第一页是 1
  ])
  try {
    const top = await pbRequest(PB_FLOOR_API, data)
    const error = pbError(top)
    if(error.code) {
      console.error('获取楼中楼失败, errorno:', error.code, error.message)
      const message = error.message || '获取楼中楼失败'
      vscode.window.showErrorMessage(message)
      return { errMessage: message }
    }
    const dataField = pbOne(top, 2)
    if(!dataField || !Buffer.isBuffer(dataField.value)) {
      return { errMessage: '获取楼中楼失败' }
    }
    const dataFields = pbParse(dataField.value)

    // 部分用户信息只在 user_list 中返回, 用 author_id 兜底
    const userMap: Record<string, string> = {}
    for(const field of dataFields) {
      if(field.field !== 13 || !Buffer.isBuffer(field.value)) {
        continue // user_list
      }
      const user = pbParse(field.value)
      userMap[String(pbNumber(pbOne(user, 2)))] = pbString(pbOne(user, 4)) || pbString(pbOne(user, 3))
    }

    const commentList: any[] = []
    for(const item of dataFields) {
      if(item.field !== 4 || !Buffer.isBuffer(item.value)) {
        continue // subpost_list
      }
      commentList.push(pbComment(pbParse(item.value), userMap))
    }

    return { commentList }
  } catch(err) {
    console.error('获取楼中楼失败', err)
    const message = '获取楼中楼失败，请检查网络或 cookie'
    vscode.window.showErrorMessage(message)
    return { errMessage: message }
  }
}
