/**
 * @react-pdf-viewer 中文本地化映射。
 *
 * 说明：
 *  - 该库的英文文案并非来自某个统一的默认 map，而是各插件（toolbar / zoom / page-navigation /
 *    rotate / get-file / print / full-screen / scroll-mode / selection-mode / properties / search /
 *    bookmark / attachment / thumbnail / theme ...）在读取 `l10n.<section>.<key>` 失败时，
 *    回退到插件内部硬编码的英文字面量。
 *  - Viewer 的 `localization` prop 会整体替换默认 l10n，故这里必须覆盖所有可见 key，
 *    才能把工具栏/侧栏/弹窗的英文提示全部转成中文（未覆盖到的项将回退英文）。
 *  - key 路径（如 zoom.zoomIn、pageNavigation.goToNextPage）逐一从各插件源码的 `l10n.*` 读取处提取，
 *    与库 v3 的 LocalizationMap 结构一致。
 */
import type { LocalizationMap } from '@react-pdf-viewer/core'

export const pdfZhCn: LocalizationMap = {
  // 核心层：密码弹窗、页码标签（{{pageIndex}} 为 0 基，与库默认一致）
  core: {
    pageLabel: '第 {{pageIndex}} 页',
    askingPassword: {
      requirePasswordToOpen: '打开此文档需要密码',
      submit: '确定',
    },
    wrongPassword: {
      tryAgain: '密码错误，请重试',
    },
  },

  // 工具栏「更多操作」入口
  toolbar: {
    moreActions: '更多操作',
  },

  // 缩放
  zoom: {
    zoomIn: '放大',
    zoomOut: '缩小',
    actualSize: '实际大小',
    pageFit: '适合页面',
    pageWidth: '适合页宽',
    zoomDocument: '缩放文档',
  },

  // 翻页导航
  pageNavigation: {
    goToFirstPage: '第一页',
    goToLastPage: '最后一页',
    goToNextPage: '下一页',
    goToPreviousPage: '上一页',
    enterPageNumber: '输入页码',
  },

  // 旋转
  rotate: {
    rotateForward: '顺时针旋转',
    rotateBackward: '逆时针旋转',
  },

  // 下载
  download: {
    download: '下载',
  },

  // 打开本地文件
  open: {
    openFile: '打开文件',
  },

  // 全屏
  fullScreen: {
    enterFullScreen: '全屏',
    exitFullScreen: '退出全屏',
  },

  // 滚动 / 页面模式
  scrollMode: {
    singlePage: '单页',
    dualPage: '双页',
    dualPageCover: '双页（封面）',
    verticalScrolling: '垂直滚动',
    horizontalScrolling: '水平滚动',
    wrappedScrolling: '换行滚动',
    pageScrolling: '按页滚动',
  },

  // 选择模式（文本 / 手型）
  selectionMode: {
    textSelectionTool: '文本选择工具',
    handTool: '手型工具',
  },

  // 默认布局侧栏标签
  defaultLayout: {
    thumbnail: '缩略图',
    bookmark: '书签',
    attachment: '附件',
  },

  // 文档属性弹窗
  properties: {
    showProperties: '文档属性',
    title: '标题',
    author: '作者',
    subject: '主题',
    keywords: '关键词',
    creator: '创建者',
    creationDate: '创建日期',
    modificationDate: '修改日期',
    fileName: '文件名',
    fileSize: '文件大小',
    pageCount: '页数',
    pdfVersion: 'PDF 版本',
    pdfProducer: '生成工具',
    close: '关闭',
  },

  // 打印
  print: {
    print: '打印',
    cancel: '取消',
    close: '关闭',
    preparingDocument: '正在准备打印文档…',
    disallowPrint: '此文档不允许打印',
  },

  // 搜索
  search: {
    search: '搜索',
    enterToSearch: '输入以搜索',
    matchCase: '区分大小写',
    wholeWords: '全字匹配',
    nextMatch: '下一个',
    previousMatch: '上一个',
    close: '关闭',
  },

  // 书签面板
  bookmark: {
    noBookmark: '暂无书签',
  },

  // 附件面板
  attachment: {
    clickToDownload: '点击下载',
    noAttachment: '暂无附件',
  },

  // 缩略图 alt 文本（{{pageIndex}} 由组件以 1 基替换）
  thumbnail: {
    thumbnailLabel: '第 {{pageIndex}} 页缩略图',
  },

  // 主题切换（亮/暗）
  theme: {
    switchDarkTheme: '切换到深色主题',
    switchLightTheme: '切换到浅色主题',
  },
}
