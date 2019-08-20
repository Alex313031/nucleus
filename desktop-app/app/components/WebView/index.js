// @flow
import React, {Component, createRef} from 'react';
import {ipcRenderer} from 'electron';
import {toast} from 'react-toastify';
import mergeImg from 'merge-img';
import {promisify} from 'util';
import os from 'os';
import path from 'path';
import pubsub from 'pubsub.js';
import BugIcon from '../icons/Bug';
import ScreenshotIcon from '../icons/Screenshot';
import cx from 'classnames';
import fs from 'fs-extra';
import {iconsColor} from '../../constants/colors';

import styles from './style.module.css';
import {
  SCROLL_DOWN,
  SCROLL_UP,
  NAVIGATION_BACK,
  NAVIGATION_FORWARD,
  NAVIGATION_RELOAD,
} from '../../constants/pubsubEvents';

const MESSAGE_TYPES = {
  scroll: 'scroll',
  click: 'click',
};

class WebView extends Component {
  constructor(props) {
    super(props);
    this.webviewRef = createRef();
  }

  componentDidMount() {
    this.webviewRef.current.addEventListener(
      'ipc-message',
      this.messageHandler
    );
    pubsub.subscribe('scroll', this.processScrollEvent);
    pubsub.subscribe('click', this.processClickEvent);
    pubsub.subscribe(SCROLL_DOWN, this.processScrollDownEvent);
    pubsub.subscribe(SCROLL_UP, this.processScrollUpEvent);
    pubsub.subscribe(NAVIGATION_BACK, this.processNavigationBackEvent);
    pubsub.subscribe(NAVIGATION_FORWARD, this.processNavigationForwardEvent);
    pubsub.subscribe(NAVIGATION_RELOAD, this.processNavigationReloadEvent);

    this.webviewRef.current.addEventListener('dom-ready', () => {
      this.initEventTriggers(this.webviewRef.current);
    });

    this.webviewRef.current.addEventListener('will-navigate', ({url}) => {
      console.log('Navigating to ', url);
      this.props.onAddressChange(url);
    });
  }

  processNavigationBackEvent = () => {
    this.webviewRef.current.goBack();
  };

  processNavigationForwardEvent = () => {
    this.webviewRef.current.goForward();
  };

  processNavigationReloadEvent = () => {
    this.webviewRef.current.reload();
  };

  processScrollEvent = message => {
    if (message.sourceDeviceId === this.props.device.id) {
      return;
    }
    this.webviewRef.current.send('scrollMessage', message.position);
  };

  processClickEvent = message => {
    if (message.sourceDeviceId === this.props.device.id) {
      return;
    }
    this.webviewRef.current.send('clickMessage', message);
  };

  processScrollDownEvent = message => {
    console.log('processScrollDownEvent');
    this.webviewRef.current.send('scrollDownMessage');
  };

  processScrollUpEvent = message => {
    this.webviewRef.current.send('scrollUpMessage');
  };

  messageHandler = ({channel: type, args: [message]}) => {
    console.log('Message recieved', message);
    switch (type) {
      case MESSAGE_TYPES.scroll:
        pubsub.publish('scroll', [message]);
        return;
      case MESSAGE_TYPES.click:
        pubsub.publish('click', [message]);
        return;
    }
  };

  initEventTriggers = webview => {
    console.log('Initializing triggers');
    webview.getWebContents().executeJavaScript(`
      responsivelyApp.deviceId = ${this.props.device.id};
      document.body.addEventListener('mouseleave', () => responsivelyApp.mouseOn = false)
      document.body.addEventListener('mouseenter', () => responsivelyApp.mouseOn = true)

      window.addEventListener('scroll', (e) => {
        if (!responsivelyApp.mouseOn) {
          return;
        }
        window.responsivelyApp.sendMessageToHost(
          '${MESSAGE_TYPES.scroll}', 
          {
            sourceDeviceId: window.responsivelyApp.deviceId,
            position: {x: window.scrollX, y: window.scrollY},
          }
        );
      });

        document.addEventListener(
          'click', 
          (e) => {
            if (e.target === window.responsivelyApp.lastClickElement || e.responsivelyAppProcessed) {
              window.responsivelyApp.lastClickElement = null;
              e.responsivelyAppProcessed = true;
              return;
            } 
            e.responsivelyAppProcessed = true;
            console.log('clicked', e);
            window.responsivelyApp.sendMessageToHost(
              '${MESSAGE_TYPES.click}', 
              {
                sourceDeviceId: window.responsivelyApp.deviceId,
                cssPath: window.responsivelyApp.cssPath(e.target),
              }
            );
          },
          true
        );
    `);
  };

  _toggleDevTools = () => {
    this.webviewRef.current.getWebContents().toggleDevTools();
  };

  _takeFullPageSnapshot = async () => {
    const images = [];
    const scrollPosition = await this.webviewRef.current.executeJavaScript(`
      var value = {left: window.scrollX, top: window.scrollY};
      value;
    `);

    //scroll to top and get the windows's scroll details
    let scrollY = 0;
    const {scrollHeight, viewPortHeight} = await this.webviewRef.current
      .executeJavaScript(`
      window.scrollTo(0,0);
      var value = {
        scrollHeight: document.body.scrollHeight,
        viewPortHeight: document.documentElement.clientHeight
      };
      value;
    `);

    do {
      images.push(await this._takeSnapshot());
      scrollY = scrollY + viewPortHeight;
      await this.webviewRef.current.executeJavaScript(`
        window.scrollTo(0, ${scrollY})
      `);
    } while (scrollHeight > scrollY + viewPortHeight);

    this.webviewRef.current.executeJavaScript(`
      window.scrollTo(${JSON.stringify(scrollPosition)})
    `);

    const mergedImage = await (await mergeImg(
      images.map(img => ({src: img.toPNG()})),
      {direction: true}
    ))
      .rgba(false)
      .background(0xffffffff);
    console.log('mergedImage', mergedImage.getBuffer);
    const getBufferAsync = promisify(mergedImage.getBuffer.bind(mergedImage));
    await this._writeScreenshotFile(
      await getBufferAsync('image/png'),
      this._getScreenshotFileName()
    );
  };

  _delay(ms) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  _takeSnapshot = () => {
    return this.webviewRef.current.getWebContents().capturePage();
  };

  _getScreenshotFileName(now = new Date()) {
    return `${this.props.device.name} - ${now
      .toLocaleDateString()
      .split('/')
      .reverse()
      .join('-')} at ${now
      .toLocaleTimeString([], {hour12: true})
      .replace(/\:/g, '.')
      .toUpperCase()}.png`;
  }

  _writeScreenshotFile = (content, name) => {
    try {
      const folder = path.join(
        os.homedir(),
        `Desktop/Responsively-Screenshots`
      );
      fs.ensureDirSync(folder);
      const filePath = path.join(folder, name);
      fs.writeFileSync(filePath, content);
      toast.info(`${this.props.device.name} screenshot taken!`);
    } catch (e) {
      console.log('err', e);
      alert('Failed to save the file !', e);
    }
  };

  _takeVisibleSectionSnapshot = async () => {
    const image = this._takeSnapshot();
    await this._writeScreenshotFile(
      image.toPNG(),
      this._getScreenshotFileName()
    );
  };

  render() {
    console.log('WebView this.props', this.props);
    const {device, browser} = this.props;
    return (
      <div className={cx(styles.webViewContainer)}>
        <div className={cx(styles.webViewToolbar)}>
          <div
            className={cx(styles.webViewToolbarIcons)}
            onClick={this._toggleDevTools}
          >
            <BugIcon width={20} color={iconsColor} />
          </div>
          <div
            className={cx(styles.webViewToolbarIcons)}
            onClick={this._takeFullPageSnapshot}
          >
            <ScreenshotIcon height={15} color={iconsColor} />
          </div>
        </div>
        <webview
          ref={this.webviewRef}
          preload="./preload.js"
          className={cx(styles.device)}
          src={browser.address || 'about:blank'}
          useragent={device.useragent}
          style={{
            width: device.width,
            height: device.height,
            transform: `scale(${browser.zoomLevel})`,
          }}
        />
      </div>
    );
  }
}

export default WebView;
