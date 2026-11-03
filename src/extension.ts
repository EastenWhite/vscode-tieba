// 官方文档 https://code.visualstudio.com/api
import * as vscode from 'vscode';
import { openPostView } from './command/openPostView'
import { ThreadProvider, ThreadNode } from './provider/ThreadProvider'
import { setCookie } from './api/axios'
import { initBlacklist, addToBlacklist, openBlacklist, getBlacklistPath } from './utils/blacklist'

export function activate(context: vscode.ExtensionContext) {
  console.log('tieba is now active!');

  // 我的吧持久化
  let defaultBaList = ['javascript', 'python'] // 默认关注的吧
  let baList: string[] = context.globalState.get('baList') || []
  if (!baList.length) {
    context.globalState.update('baList', defaultBaList)
    baList = defaultBaList
  }

  // cookie 持久化
  let cookie: string = context.globalState.get('cookie') || ''
  setCookie(cookie, context) // 首次加载state中的cookie，传入context

  // 黑名单文件初始化
  initBlacklist(context)

  // 注册「打开 webview」命令
  context.subscriptions.push(openPostView(context))

  // 注册命令的示例，搜索「tieba.sayHello」查看命令调用的位置
  context.subscriptions.push(vscode.commands.registerCommand('tieba.sayHello', function (e) {
    console.log(e)
    vscode.window.showInformationMessage('tieba example：Hello World!');
  }));

  // 创建树
  let threadProvider = new ThreadProvider(baList)
  vscode.window.createTreeView(
    'tieba-index',
    {
      treeDataProvider: threadProvider
    }
  )

  // 刷新帖子列表
  vscode.commands.registerCommand('tieba-index.refresh', (node: ThreadNode) => {
    node.params = null
    threadProvider.refresh(node)
  })

  // 删除吧
  vscode.commands.registerCommand('tieba.delete', (node: ThreadNode) => {
    console.log('delete', node.label)
    baList = baList.filter(item => item !== node.label)
    context.globalState.update('baList', baList)
    threadProvider = new ThreadProvider(baList)
    vscode.window.createTreeView(
      'tieba-index',
      {
        treeDataProvider: threadProvider
      }
    )
  })

  // 删除帖子并加入黑名单, 需二次确认
  context.subscriptions.push(vscode.commands.registerCommand('tieba.deleteThread', async (node: ThreadNode) => {
    if(!node || !node.thread) {
      return // 命令面板直接调用时没有节点
    }
    const confirm = await vscode.window.showWarningMessage(
      `确定将「${node.label}」加入黑名单？加入后该帖不再显示。`,
      { modal: true },
      '确定'
    )
    if(confirm !== '确定') {
      return
    }
    addToBlacklist(node.label)
    threadProvider.refresh(node.parent)
    vscode.window.showInformationMessage(`已将「${node.label}」加入黑名单`)
  }))

  // 编辑黑名单
  context.subscriptions.push(vscode.commands.registerCommand('tieba.editBlacklist', () => {
    return openBlacklist()
  }))

  // 黑名单文件保存后刷新列表
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
    if(doc.uri.fsPath === getBlacklistPath()) {
      threadProvider.refresh()
    }
  }))

  // 搜索帖子
  vscode.commands.registerCommand('tieba.search', async (node: ThreadNode) => {
    console.log('search ba', node.label)
    const pick = await vscode.window.showQuickPick([
      {
        label: '按时间倒序',
        // description: '123123123',
        query: {
          // isnew: 1,
          // un: '',
          // sd: '',
          // ed: '',
          // rn: 20, // 大概是每页有多少个
          // sm: 1, // 1 按时间倒序，2按相关性顺序，0按时间顺序
          // pn: 1, // 页数
          // only_thread: 0 // 只看主题
        }
      },
      {
        label: '按时间顺序',
        query: {
          isnew: 1,
          un: '',
          sd: '',
          ed: '',
          rn: 20, // 大概是每页有多少个
          sm: 0, // 1 按时间倒序，2按相关性顺序，0按时间顺序
          pn: 1, // 页数
          only_thread: 0 // 只看主题
        }
      },
      {
        label: '按相关性顺序',
        query: {
          isnew: 1,
          un: '',
          sd: '',
          ed: '',
          rn: 20, // 大概是每页有多少个
          sm: 2, // 1 按时间倒序，2按相关性顺序，0按时间顺序
          pn: 1, // 页数
          only_thread: 0 // 只看主题
        }
      },
      {
        label: '只看主题贴',
        query: {
          isnew: 1,
          un: '',
          sd: '',
          ed: '',
          rn: 20, // 大概是每页有多少个
          sm: 1, // 1 按时间倒序，2按相关性顺序，0按时间顺序
          pn: 1, // 页数
          only_thread: 1 // 只看主题
        }
      },
    ])
    console.log('pick', pick)

    const keyword = await vscode.window.showInputBox({
      placeHolder: '输入搜索内容'
    })
    console.log('keyword', keyword)

    if(pick && keyword) {
      const query = Object.assign(pick.query, {
        kw: node.label,
        qw: keyword,
        ie: 'utf-8'
      })
      node.params = query
      threadProvider.refresh(node)
    }
  })

  // 增加一个吧
  vscode.commands.registerCommand('tieba.add', (node: ThreadNode) => {
    vscode.window.showInputBox({
      placeHolder: '添加贴吧'
    }).then(baName => {
      if (baName) {
        baList.push(baName)
        context.globalState.update('baList', baList)
        threadProvider = new ThreadProvider(baList)
        vscode.window.createTreeView(
          'tieba-index',
          {
            treeDataProvider: threadProvider
          }
        )
      }
    })
  })

  // 修改cookie
  vscode.commands.registerCommand('tieba.cookie', (node: ThreadNode) => {
    vscode.window.showInputBox({
      placeHolder: '输入贴吧cookie'
    }).then(cookie => {
      if (cookie) {
        setCookie(cookie)
        vscode.window.showInformationMessage('设置cookie成功')
        console.log('your cookies:', cookie)
      }
    })
  })

  // 用浏览器打开帖子
  vscode.commands.registerCommand('tieba.openExternal', (node: ThreadNode) => {
    const uri = vscode.Uri.parse(node.thread!.href)
    vscode.env.openExternal(uri)
  })
}

export function deactivate() {
  console.log('deactivate')
}
