;(function () {
  function createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...props,
        children: children.map(child => {
          const isTextNode =
            typeof child === 'string' || typeof child === 'number'
          return isTextNode ? createTextNode(child) : child
        }),
      },
    }
  }

  // 文本节点单独处理，为了加上type
  function createTextNode(nodeValue) {
    return {
      type: 'TEXT_ELEMENT',
      props: {
        nodeValue,
        children: [],
      },
    }
  }

  let nextUnitOfWork = null // 下一个要处理的 fiber 节点，Fiber 是组件更新的最小单元
  let wipRoot = null // 当前正在构建的 Fiber 树的根节点。React进行渲染时，创建一颗新的 Fiber 树，直到这棵树构建完成才会替换旧的树
  let currentRoot = null // 当前页面已经渲染的 Fiber 树的根节点。渲染完成后wipRoot会被赋值给currentRoot，即完成树的替换
  let deletions = null // 删除节点

  // 将react元素 渲染到 DOM 容器
  function render(element, container) {
    // 创建一颗树的根节点，保存
    wipRoot = {
      dom: container, // 存储目标容器的 DOM 元素，用于挂载渲染结果
      props: {
        children: [element], // 渲染的子组件或者子元素
      },
      alternate: currentRoot, // 保存当前已经渲染的 Fiber 树的根节点，用于后续做 diff
    }

    deletions = []
    nextUnitOfWork = wipRoot // 将新建的 Fiber 树 赋值给 nextUnitOfWork，作为第一个工作单元，表示从根节点开始工作
  }

  // 构建 fiber 链表，按照 child、sibling、return 的顺序返回下一个要处理的 fiber 节点
  function performUnitOfWork(fiber) {
    const isFunctionComponent = fiber.type instanceof Function
    if (isFunctionComponent) {
      // 函数式组件
      updateFunctionComponent(fiber)
    } else {
      // 原生标签
      updateHostComponent(fiber)
    }

    // 存在子节点，先处理子节点
    if (fiber.child) {
      return fiber.child
    }

    let nextFiber = fiber
    while (nextFiber) {
      if (nextFiber.sibling) {
        // 存在兄弟节点，处理兄弟节点
        return nextFiber.sibling
      }
      // 即没有子节点也没有兄弟节点，继续向上回溯到父节点，查看父节点是否有其他未处理的兄弟节点...
      nextFiber = nextFiber.return
    }
  }

  let wipFiber = null // 指向当前处理的fiber
  let stateHookIndex = null // 存取前一个fiber节点的useState的hook函数并将其执行完而设立的坐标

  // 初始化/更新 函数组件的fiber节点
  function updateFunctionComponent(fiber) {
    wipFiber = fiber
    stateHookIndex = 0
    wipFiber.stateHooks = []
    wipFiber.effectHooks = []

    const children = [fiber.type(fiber.props)]
    reconcileChildren(fiber, children)
  }

  // 这里是初始化/更新原生组件的fiber节点，创建dom
  function updateHostComponent(fiber) {
    if (!fiber.dom) {
      fiber.dom = createDom(fiber)
    }
    reconcileChildren(fiber, fiber.props.children)
  }

  // 渲染器的主循环，负责在浏览器的空闲时间执行工作
  function workLoop(deadline) {
    // deadline.timeRemaining 检查浏览器当前帧还剩多长时间，通过这个机制，渲染器可以避免长时间占用主线程，保证页面的流畅性
    let shouldYield = false
    while (nextUnitOfWork && !shouldYield) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
      // 每个工作单元处理完后，检查是否还剩下足够的时间，如果时间不足（小于1ms），暂停当前循环，等待下一个空闲时间
      shouldYield = deadline.timeRemaining() < 1
    }

    // fiber 链表就构建好，在 fiber 上打上了增删改的标记，并且也保存了要执行的 effect，执行 commit
    if (!nextUnitOfWork && wipRoot) {
      commitRoot()
    }

    // 递归的请求下一个空闲时间继续工作
    requestIdleCallback(workLoop)
  }

  // 初始化渲染循环
  requestIdleCallback(workLoop)

  // 创建 dom
  function createDom(fiber) {
    const dom =
      fiber.type == 'TEXT_ELEMENT'
        ? document.createTextNode('')
        : document.createElement(fiber.type)

    updateDom(dom, {}, fiber.props)

    return dom
  }

  const isEvent = key => key.startsWith('on')
  const isProperty = key => key !== 'children' && !isEvent(key)
  const isNew = (prev, next) => key => prev[key] !== next[key]
  const isGone = (prev, next) => key => !(key in next) // 旧的属性不存在

  // 更新
  function updateDom(dom, prevProps, nextProps) {
    // 移除旧的 / 改变的事件
    Object.keys(prevProps)
      .filter(isEvent)
      .filter(key => !(key in nextProps) || isNew(prevProps, nextProps)(key))
      .forEach(name => {
        const eventType = name.toLowerCase().substring(2)
        dom.removeEventListener(eventType, prevProps[name])
      })

    // 移除旧的属性
    Object.keys(prevProps)
      .filter(isProperty)
      .filter(isGone(prevProps, nextProps))
      .forEach(name => (dom[name] = ''))

    // 设置 新的 / 改变的属性
    Object.keys(nextProps)
      .filter(isProperty)
      .filter(isNew(prevProps, nextProps))
      .forEach(name => {
        dom[name] = nextProps[name]
      })

    // 增加事件监听
    Object.keys(nextProps)
      .filter(isEvent)
      .filter(isNew(prevProps, nextProps))
      .forEach(name => {
        const eventType = name.toLowerCase().substring(2)
        dom.addEventListener(eventType, nextProps[name])
      })
  }

  // 构建子节点的 fiber
  // 给新旧节点上标记，遍历比较新旧两组fiber节点的子元素
  // 打上删除/新增/更新 三种标记effectTag， 其中删除标记要存在 deletions 数组中
  function reconcileChildren(wipFiber, elements) {
    let index = 0
    let oldFiber = wipFiber.alternate?.child
    let prevSibling = null

    while (index < elements.length || oldFiber != null) {
      const element = elements[index]
      let newFiber = null

      const sameType = element?.type === oldFiber?.type

      if (sameType) {
        newFiber = {
          type: oldFiber?.type,
          props: element.props,
          dom: oldFiber.dom,
          return: wipFiber,
          alternate: oldFiber,
          effectTag: 'UPDATE',
        }
      }

      // 新增
      if (element && !sameType) {
        newFiber = {
          type: element.type,
          props: element.props,
          dom: null,
          return: wipFiber,
          alternate: null,
          effectTag: 'PLACEMENT',
        }
      }

      // 删除
      if (oldFiber && !sameType) {
        oldFiber.effectTag = 'DELETION'
        deletions.push(oldFiber)
      }

      // 处理child之后处理 sibling
      if (oldFiber) {
        oldFiber = oldFiber.sibling
      }

      if (index === 0) {
        wipFiber.child = newFiber
      } else if (element) {
        prevSibling.sibling = newFiber
      }

      prevSibling = newFiber
      index++
    }
  }

  function useState(initialState) {
    const currentFiber = wipFiber

    const oldHook = wipFiber.alternate?.stateHooks[stateHookIndex]

    const stateHook = {
      state: oldHook ? oldHook.state : initialState,
      queue: oldHook ? oldHook.queue : [],
    }

    stateHook.queue.forEach(action => {
      stateHook.state = action(stateHook.state)
    })

    stateHook.queue = []

    stateHookIndex++
    wipFiber.stateHooks.push(stateHook)

    function setState(action) {
      const isFunction = typeof action === 'function'

      stateHook.queue.push(isFunction ? action : () => action)

      wipRoot = {
        ...currentFiber,
        alternate: currentFiber,
      }

      nextUnitOfWork = wipRoot
    }

    return [stateHook.state, setState]
  }

  // 在 fiber.effectHooks 上添加一个元素
  function useEffect(callback, deps) {
    const effectHook = {
      callback,
      deps,
      cleanup: undefined,
    }
    wipFiber.effectHooks.push(effectHook)
  }

  function commitRoot() {
    // 删除节点
    deletions.forEach(commitWork)
    commitWork(wipRoot.child)
    // 处理 effect
    commitEffectHooks()
    currentRoot = wipRoot
    wipRoot = null
    deletions = []
  }

  // 递归执行增删改查的工作
  function commitWork(fiber) {
    if (!fiber) {
      return
    }

    let domParentFiber = fiber.return
    // 不断向上寻找可以挂载的dom
    while (!domParentFiber.dom) {
      domParentFiber = domParentFiber.return
    }

    const domParent = domParentFiber.dom

    // 按照 增删改来做处理
    if (fiber.effectTag === 'PLACEMENT' && fiber.dom != null) {
      domParent.appendChild(fiber.dom)
    } else if (fiber.effectTag === 'UPDATE' && fiber.dom != null) {
      updateDom(fiber.dom, fiber.alternate.props, fiber.props)
    } else if (fiber.effectTag === 'DELETION') {
      commitDeletion(fiber, domParent)
    }

    // 依次处理 child sibling
    commitWork(fiber.child)
    commitWork(fiber.sibling)
  }

  // 删除节点
  function commitDeletion(fiber, domParent) {
    if (fiber.dom) {
      domParent.removeChild(fiber.dom)
    } else {
      // 当前 fiber 节点没有对应的 dom，就不断 child 向下找
      commitDeletion(fiber.child, domParent)
    }
  }

  // 先清除之前状态的effect函数（就是调用之前状态的return），再去执行当前状态的effect
  function commitEffectHooks() {
    function runCleanup(fiber) {
      if (!fiber) return

      fiber.alternate?.effectHooks?.forEach((hook, index) => {
        const deps = fiber.effectHooks[index].deps

        // 没有传入 deps 或者 deps 数组变化的时候，执行上一次的 cleanup
        if (!hook.deps || !isDepsEqual(hook.deps, deps)) {
          hook.cleanup?.()
        }
      })

      // 递归处理每个节点
      runCleanup(fiber.child)
      runCleanup(fiber.sibling)
    }

    function run(fiber) {
      if (!fiber) return

      fiber.effectHooks?.forEach((newHook, index) => {
        // 首次渲染，执行所有的 effect
        if (!fiber.alternate) {
          newHook.cleanup = newHook.callback()
          return
        }

        // 没传入 deps
        if (!newHook.deps) {
          newHook.cleanup = newHook.callback()
        }

        // deps 数组变化的时候再执行 effect 函数
        if (newHook.deps.length > 0) {
          const oldHook = fiber.alternate?.effectHooks[index]

          if (!isDepsEqual(oldHook.deps, newHook.deps)) {
            newHook.cleanup = newHook.callback()
          }
        }
      })

      run(fiber.child)
      run(fiber.sibling)
    }

    runCleanup(wipRoot)
    run(wipRoot)
  }

  // effectHook 的依赖是否相等
  function isDepsEqual(deps, newDeps) {
    if (deps.length !== newDeps.length) {
      return false
    }

    for (let i = 0; i < deps.length; i++) {
      if (deps[i] !== newDeps[i]) {
        return false
      }
    }
    return true
  }

  const MiniReact = {
    createElement,
    render,
    useState,
    useEffect,
  }

  window.MiniReact = MiniReact
})()
