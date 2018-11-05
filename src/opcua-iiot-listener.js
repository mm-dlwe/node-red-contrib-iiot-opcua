/*
 The BSD 3-Clause License

 Copyright 2016,2017,2018 - Klaus Landsdorf (http://bianco-royal.de/)
 Copyright 2015,2016 - Mika Karaila, Valmet Automation Inc. (node-red-contrib-opcua)
 All rights reserved.
 node-red-contrib-iiot-opcua
 */
'use strict'

/**
 * Listener Node-RED node.
 *
 * @param RED
 */
module.exports = function (RED) {
  // SOURCE-MAP-REQUIRED
  let coreListener = require('./core/opcua-iiot-core-listener')
  let Map = require('collections/map')
  const _ = require('underscore')

  function OPCUAIIoTListener (config) {
    RED.nodes.createNode(this, config)
    this.action = config.action
    this.queueSize = config.queueSize || 1
    this.name = config.name
    this.topic = config.topic
    this.justValue = config.justValue
    this.useGroupItems = config.useGroupItems
    this.showStatusActivities = config.showStatusActivities
    this.showErrors = config.showErrors
    this.connector = RED.nodes.getNode(config.connector)

    let node = this
    node.opcuaClient = null
    node.opcuaSession = null

    let uaSubscription = null
    let StatusCodes = coreListener.core.nodeOPCUA.StatusCodes
    let AttributeIds = coreListener.core.nodeOPCUA.AttributeIds
    node.monitoredItems = new Map()
    node.monitoredASO = new Map()
    node.messageQueue = []

    node.stateMachine = coreListener.createStatelyMachine()
    coreListener.internalDebugLog('Start FSM: ' + node.stateMachine.getMachineState())
    coreListener.detailDebugLog('FSM events:' + node.stateMachine.getMachineEvents())

    node.createSubscription = function (msg) {
      if (node.stateMachine.getMachineState() !== 'IDLE') {
        coreListener.internalDebugLog('New Subscription Request On State ' + node.stateMachine.getMachineState())
        return
      }
      coreListener.internalDebugLog('Create Subscription On State ' + node.stateMachine.getMachineState())
      uaSubscription = null
      node.stateMachine.requestinitsub()

      const timeMilliseconds = (typeof msg.payload === 'number') ? msg.payload : null
      const dynamicOptions = (msg.payload.listenerParameters) ? msg.payload.listenerParameters.options : msg.payload.options

      if (node.action !== 'events') {
        coreListener.internalDebugLog('create monitoring subscription')
        const monitoringOptions = dynamicOptions || coreListener.getSubscriptionParameters(timeMilliseconds)
        node.makeSubscription(monitoringOptions)
      } else {
        coreListener.internalDebugLog('create event subscription')
        const eventOptions = dynamicOptions || coreListener.getEventSubscribtionParameters(timeMilliseconds)
        node.makeSubscription(eventOptions)
      }
    }

    node.setSubscriptionEvents = function (subscription) {
      subscription.on('started', function () {
        coreListener.internalDebugLog('Subscription started')
        coreListener.core.setNodeStatusTo(node, 'started')
        node.monitoredItems.clear()
        node.stateMachine.startsub()
      })

      subscription.on('terminated', function () {
        coreListener.internalDebugLog('Subscription terminated')
        coreListener.core.setNodeStatusTo(node, 'terminated')
        node.stateMachine.terminatesub().idlesub()
        node.resetSubscription()
      })

      subscription.on('internal_error', function (err) {
        coreListener.internalDebugLog('internal_error: ' + err.message)
        if (node.showErrors) {
          node.error(err, {payload: 'Internal Error'})
        }
        coreListener.core.setNodeStatusTo(node, 'error')
        node.stateMachine.errorsub()
        node.resetSubscription()
      })

      subscription.on('item_added', function (monitoredItem) {
        node.setMonitoring(monitoredItem)
        node.updateSubscriptionStatus()
      })
    }

    node.makeSubscription = function (parameters) {
      if (coreListener.core.checkSessionNotValid(node.opcuaSession, 'ListenerSubscription')) {
        return
      }

      if (!parameters) {
        coreListener.internalDebugLog('Subscription Parameters Not Valid')
        return
      } else {
        coreListener.internalDebugLog('Subscription Parameters: ' + JSON.stringify(parameters))
      }

      uaSubscription = new coreListener.core.nodeOPCUA.ClientSubscription(node.opcuaSession, parameters)
      coreListener.internalDebugLog('New Subscription Created')

      if (node.connector) {
        node.connector.hasOpcUaSubscriptions = true
      }

      node.setSubscriptionEvents(uaSubscription)
      node.stateMachine.initsub()
    }

    node.resetSubscription = function () {
      node.sendAllMonitoredItems('SUBSCRIPTION TERMINATED')
    }

    node.sendAllMonitoredItems = function (payload) {
      let addressSpaceItems = []

      node.monitoredASO.forEach(function (value, key) {
        addressSpaceItems.push({name: '', nodeId: key, datatypeName: ''})
      })

      node.send({payload: payload, addressSpaceItems: addressSpaceItems})

      node.monitoredItems.clear()
      node.monitoredASO.clear()

      /*
      if (node.connector) {
        node.connector.hasOpcUaSubscriptions = false
      }
       */
    }

    node.subscribeActionInput = function (msg) {
      if (node.stateMachine.getMachineState() !== coreListener.RUNNING_STATE) {
        node.messageQueue.push(msg)
      } else {
        node.subscribeMonitoredItem(msg)
      }
    }

    node.subscribeEventsInput = function (msg) {
      if (node.stateMachine.getMachineState() !== coreListener.RUNNING_STATE) {
        node.messageQueue.push(msg)
      } else {
        node.subscribeMonitoredEvent(msg)
      }
    }

    node.updateSubscriptionStatus = function () {
      coreListener.internalDebugLog('listening' + ' (' + node.monitoredItems.size + ')')
      coreListener.core.setNodeStatusTo(node, 'listening' + ' (' + node.monitoredItems.size + ')')
    }

    node.handleMonitoringOfGroupedItems = function (msg) {
      if (node.monitoredItemGroup && node.monitoredItemGroup.groupId !== null) {
        node.monitoredItemGroup.terminate(function (err) {
          if (err) {
            coreListener.internalDebugLog('Monitoring Terminate Error')
            coreListener.internalDebugLog(err)
          }
          node.monitoredItems.clear()
          node.monitoredASO.clear()
          node.monitoredItemGroup.groupId = null
          node.updateSubscriptionStatus()
        })
      } else {
        coreListener.buildNewMonitoredItemGroup(node, msg, msg.addressSpaceItems, uaSubscription)
          .then(function (result) {
            if (!result.monitoredItemGroup) {
              node.error(new Error('No Monitored Item Group In Result Of NodeOPCUA'))
            } else {
              result.monitoredItemGroup.groupId = _.uniqueId('group_')
              node.monitoredItemGroup = result.monitoredItemGroup
            }
          }).catch(function (err) {
            coreListener.subscribeDebugLog('Monitoring Build Item Group Error')
            coreListener.subscribeDebugLog(err)
            if (node.showErrors) {
              node.error(err, msg)
            }
          })
      }
    }

    node.handleMonitoringOfItems = function (msg) {
      const itemsToMonitor = msg.addressSpaceItems.filter(addressSpaceItem => {
        const nodeIdToMonitor = (typeof addressSpaceItem.nodeId === 'string') ? addressSpaceItem.nodeId : addressSpaceItem.nodeId.toString()
        return typeof node.monitoredASO.get(nodeIdToMonitor) === 'undefined'
      })

      const itemsToTerminate = msg.addressSpaceItems.filter(addressSpaceItem => {
        const nodeIdToMonitor = (typeof addressSpaceItem.nodeId === 'string') ? addressSpaceItem.nodeId : addressSpaceItem.nodeId.toString()
        return typeof node.monitoredASO.get(nodeIdToMonitor) !== 'undefined'
      })

      if (itemsToMonitor.length > 0) {
        const monitorMessage = Object.assign({}, msg)
        monitorMessage.addressSpaceItems = itemsToMonitor
        coreListener.subscribeDebugLog('itemsToMonitor ' + itemsToMonitor.length)
        coreListener.monitorItems(node, monitorMessage, uaSubscription)
      }

      if (itemsToTerminate.length > 0) {
        coreListener.subscribeDebugLog('itemsToTerminate ' + itemsToTerminate.length)
        itemsToTerminate.forEach((addressSpaceItem) => {
          const nodeIdToMonitor = (typeof addressSpaceItem.nodeId === 'string') ? addressSpaceItem.nodeId : addressSpaceItem.nodeId.toString()
          const item = node.monitoredASO.get(nodeIdToMonitor)
          if (item && item.monitoredItem) {
            coreListener.subscribeDebugLog('Monitored Item Unsubscribe ' + nodeIdToMonitor)
            item.monitoredItem.terminate(function (err) {
              coreListener.subscribeDebugLog('Terminated Monitored Item ' + item.monitoredItem.itemToMonitor.nodeId)
              node.monitoredItemTerminated(msg, item.monitoredItem, nodeIdToMonitor, err)
            })
          } else {
            coreListener.subscribeDebugLog('Monitored Item Was Not Monitoring ' + nodeIdToMonitor)
          }
        })
      }
    }

    node.subscribeMonitoredItem = function (msg) {
      if (coreListener.core.checkSessionNotValid(node.opcuaSession, 'MonitorListener')) {
        return
      }

      if (!coreListener.checkState(node, msg, 'Monitoring')) {
        return
      }

      if (msg.addressSpaceItems.length) {
        if (node.useGroupItems) {
          node.handleMonitoringOfGroupedItems(msg)
        } else {
          node.handleMonitoringOfItems(msg)
        }
      }
    }

    node.handleEventSubscriptions = function (msg) {
      for (let addressSpaceItem of msg.addressSpaceItems) {
        if (!addressSpaceItem.nodeId) {
          coreListener.eventDebugLog('Address Space Item Not Valid to Monitor Event Of ' + addressSpaceItem)
          return
        }

        if (addressSpaceItem.datatypeName === 'ns=0;i=0') {
          coreListener.subscribeDebugLog('Address Space Item Not Allowed to Monitor ' + addressSpaceItem)
          return
        }

        let nodeIdToMonitor
        if (typeof addressSpaceItem.nodeId === 'string') {
          nodeIdToMonitor = addressSpaceItem.nodeId
        } else {
          nodeIdToMonitor = addressSpaceItem.nodeId.toString()
        }

        const item = node.monitoredASO.get(nodeIdToMonitor)

        if (!item) {
          coreListener.eventDebugLog('Regsiter Event Item ' + nodeIdToMonitor)
          coreListener.buildNewEventItem(nodeIdToMonitor, msg, uaSubscription)
            .then(function (result) {
              if (result.monitoredItem.monitoredItemId) {
                coreListener.eventDebugLog('Event Item Regsitered ' + result.monitoredItem.monitoredItemId + ' to ' + result.nodeId)
                node.monitoredASO.set(result.nodeId.toString(), {
                  monitoredItem: result.monitoredItem,
                  topic: msg.topic || node.topic
                })
              }
            }).catch(function (err) {
              coreListener.eventDebugLog('Build Event Error')
              coreListener.eventDebugLog(err)
              if (node.showErrors) {
                node.error(err, msg)
              }
            })
        } else {
          coreListener.eventDebugLog('Terminate Event Item' + nodeIdToMonitor)
          const eventMessage = Object.assign({}, msg)
          item.monitoredItem.terminate(function (err) {
            coreListener.eventDebugLog('Terminated Monitored Item ' + item.monitoredItem.itemToMonitor.nodeId)
            node.monitoredItemTerminated(eventMessage, item.monitoredItem, nodeIdToMonitor, err)
          })
        }
      }
    }

    node.subscribeMonitoredEvent = function (msg) {
      if (coreListener.core.checkSessionNotValid(node.opcuaSession, 'EventListener')) {
        return
      }

      if (!coreListener.checkState(node, msg, 'Event')) {
        return
      }

      node.handleEventSubscriptions(msg)
    }

    node.monitoredItemTerminated = function (msg, monitoredItem, nodeId, err) {
      if (err) {
        if (monitoredItem && monitoredItem.monitoredItemId) {
          coreListener.internalDebugLog(err.message + ' on ' + monitoredItem.monitoredItemId)
        } else {
          coreListener.internalDebugLog(err.message + ' on monitoredItem')
        }
        if (node.showErrors) {
          node.error(err, msg)
        }
      }
      node.updateMonitoredItemLists(monitoredItem, nodeId)
    }

    node.updateMonitoredItemLists = function (monitoredItem, nodeId) {
      coreListener.internalDebugLog('updateMonitoredItemLists = UMIL')

      if (monitoredItem && monitoredItem.itemToMonitor) {
        if (node.monitoredItems.has(monitoredItem.monitoredItemId)) {
          node.monitoredItems.delete(monitoredItem.monitoredItemId)
        }

        if (coreListener.core.isNodeId(monitoredItem.itemToMonitor.nodeId)) {
          coreListener.internalDebugLog('UMIL Terminate Monitored Item ' + monitoredItem.itemToMonitor.nodeId)
          if (node.monitoredASO.has(nodeId)) {
            node.monitoredASO.delete(nodeId)
          }
        } else {
          coreListener.internalDebugLog('UMIL monitoredItem NodeId is not valid Id:' + monitoredItem.monitoredItemId)
          node.monitoredASO.forEach(function (value, key, map) {
            coreListener.internalDebugLog('UMIL monitoredItem removing from ASO list key:' + key + ' value ' + value.monitoredItem.monitoredItemId)
            if (value.monitoredItem.monitoredItemId && value.monitoredItem.monitoredItemId === monitoredItem.monitoredItemId) {
              coreListener.internalDebugLog('UMIL monitoredItem removed from ASO list' + key)
              map.delete(key)
            }
          })
        }

        node.updateSubscriptionStatus()
      }
    }

    node.setMonitoring = function (monitoredItemToSet) {
      const monitoredItem = monitoredItemToSet
      if (!monitoredItem || monitoredItem.monitoredItemId === void 0) {
        coreListener.internalDebugLog('monitoredItem Id from server is not valid Id: ' + monitoredItem.monitoredItemId)
        return
      }

      if (!coreListener.core.isNodeId(monitoredItem.itemToMonitor.nodeId)) {
        coreListener.internalDebugLog('monitoredItem NodeId is not valid Id:' + monitoredItem.monitoredItemId)
      }

      coreListener.internalDebugLog('add monitoredItem to list Id:' + monitoredItem.monitoredItemId + ' nodeId: ' + monitoredItem.itemToMonitor.nodeId)
      node.monitoredItems.set(monitoredItem.monitoredItemId, monitoredItem)

      monitoredItem.on('initialized', function () {
        coreListener.internalDebugLog('monitoredItem ' + monitoredItem.itemToMonitor.nodeId + ' initialized on ' + monitoredItem.monitoredItemId)
      })

      monitoredItem.on('changed', function (dataValue) {
        coreListener.detailDebugLog('data changed for item: ' + monitoredItem.itemToMonitor.nodeId + ' with Id ' + monitoredItem.monitoredItemId)
        if (!monitoredItem.monitoringParameters.filter) {
          node.sendDataFromMonitoredItem(monitoredItem, dataValue)
        } else {
          node.sendDataFromEvent(monitoredItem, dataValue)
        }
      })

      monitoredItem.on('error', function (err) {
        coreListener.internalDebugLog('monitoredItem Error: ' + err.message + ' on ' + monitoredItem.monitoredItemId)
        if (node.showErrors) {
          node.error(err, {payload: 'Monitored Item Error', monitoredItem: monitoredItem})
        }

        node.updateMonitoredItemLists(monitoredItem, monitoredItem.itemToMonitor.nodeId)

        if (node.connector && coreListener.core.isSessionBad(err)) {
          node.sendAllMonitoredItems('BAD SESSION')
          node.terminateSubscription(() => {
            node.connector.resetBadSession()
          })
        }
      })

      monitoredItem.on('terminated', function () {
        coreListener.internalDebugLog('Terminated For ' + monitoredItem.monitoredItemId)
        node.updateMonitoredItemLists(monitoredItem, monitoredItem.itemToMonitor.nodeId)
      })
    }

    node.sendDataFromMonitoredItem = function (monitoredItem, dataValue) {
      if (!monitoredItem) {
        coreListener.internalDebugLog('Monitored Item Is Not Valid On Change Event While Monitoring')
        return
      }

      const nodeId = (coreListener.core.isNodeId(monitoredItem.itemToMonitor.nodeId)) ? monitoredItem.itemToMonitor.nodeId.toString() : 'invalid'
      const item = node.monitoredASO.get(nodeId)
      const topic = (item) ? item.topic : node.topic

      let msg = {
        payload: {},
        topic: topic,
        addressSpaceItems: [{name: '', nodeId, datatypeName: ''}],
        nodetype: 'listen',
        injectType: 'subscribe'
      }

      coreListener.internalDebugLog('sendDataFromMonitoredItem: ' + msg.addressSpaceItems[0].nodeId)

      let dataValuesString = {}
      msg.justValue = node.justValue
      if (node.justValue) {
        dataValuesString = JSON.stringify(dataValue, null, 2)
        try {
          RED.util.setMessageProperty(msg, 'payload', JSON.parse(dataValuesString))
        } catch (err) {
          if (node.showErrors) {
            node.warn('JSON not to parse from string for monitored item')
            node.error(err, msg)
          }

          msg.payload = dataValuesString
          msg.error = err.message
        }
      } else {
        msg.payload = {dataValue, monitoredItem}
      }

      node.send(msg)
    }

    node.handleEventResults = function (msg, dataValue, eventResults, monitoredItem) {
      coreListener.eventDetailDebugLog('Monitored Event Results ' + eventResults)

      let dataValuesString = {}
      if (node.justValue) {
        dataValuesString = JSON.stringify({dataValue: dataValue}, null, 2)
        try {
          RED.util.setMessageProperty(msg, 'payload', JSON.parse(dataValuesString))
        } catch (err) {
          if (node.showErrors) {
            node.warn('JSON not to parse from string for monitored item')
            node.error(err, msg)
          }

          msg.payload = dataValuesString
          msg.error = err.message
        }
      } else {
        msg.payload = {dataValue, eventResults, monitoredItem}
      }

      node.send(msg)
    }

    node.sendDataFromEvent = function (monitoredItem, dataValue) {
      if (!monitoredItem) {
        coreListener.internalDebugLog('Monitored Item Is Not Valid On Change Event While Monitoring')
        return
      }

      const nodeId = (coreListener.core.isNodeId(monitoredItem.itemToMonitor.nodeId)) ? monitoredItem.itemToMonitor.nodeId.toString() : 'invalid'
      const item = node.monitoredASO.get(nodeId)
      const topic = (item) ? item.topic : node.topic

      let msg = {
        payload: {},
        topic: topic || node.topic, // default if item.topic is empty
        addressSpaceItems: [{name: '', nodeId: nodeId, datatypeName: ''}],
        nodetype: 'listen',
        injectType: 'event'
      }

      coreListener.analyzeEvent(node.opcuaSession, node.getBrowseName, dataValue)
        .then(function (eventResults) {
          node.handleEventResults(msg, dataValue, eventResults, monitoredItem)
        }).catch(function (err) {
          node.errorHandling(err)
        })
    }

    node.errorHandling = function (err) {
      coreListener.internalDebugLog('Basic Error Handling')
      coreListener.internalDebugLog(err)
      if (node.showErrors) {
        node.error(err, {payload: 'Error Handling'})
      }

      if (err) {
        if (coreListener.core.isSessionBad(err)) {
          node.sendAllMonitoredItems('BAD SESSION')
          if (node.connector) {
            node.terminateSubscription(() => {
              node.connector.resetBadSession()
            })
          }
        }
      }
    }

    node.getBrowseName = function (session, nodeId, callback) {
      coreListener.client.read(session, [{
        nodeId: nodeId,
        attributeId: AttributeIds.BrowseName
      }], function (err, org, readValue) {
        if (!err) {
          if (readValue[0].statusCode === StatusCodes.Good) {
            let browseName = readValue[0].value.value.name
            return callback(null, browseName)
          }
        }
        callback(err, 'Unknown')
      })
    }

    node.handleListenerInput = function (msg) {
      switch (node.action) {
        case 'subscribe':
          node.subscribeMonitoredItem(msg)
          break
        case 'events':
          node.subscribeMonitoredEvent(msg)
          break
        default:
          node.error(new Error('Type Of Action To Listener Is Not Valid'), msg)
      }
    }

    node.on('input', function (msg) {
      if (!coreListener.core.checkConnectorState(node, msg, 'Listener')) {
        return
      }

      if (msg.nodetype === 'browse') { /* browse is just to address listening to many nodes */
        msg.nodetype = 'inject'
        msg.injectType = 'listen'
        msg.addressSpaceItems = coreListener.core.buildNodesToListen(msg)
      }

      if (!msg.addressSpaceItems || !msg.addressSpaceItems.length) {
        coreListener.subscribeDebugLog('Address-Space-Item Set Not Valid')
        if (node.showErrors) {
          node.error(new Error('Address-Space-Item Set Not Valid'), msg)
        }
        return
      }

      if (node.stateMachine.getMachineState() === 'IDLE') {
        node.messageQueue.push(msg)
        node.createSubscription(msg)
      } else {
        if (!coreListener.checkState(node, msg, 'Input')) {
          node.messageQueue.push(msg)
          return
        }
        node.handleListenerInput(msg)
      }
    })

    node.terminateSubscriptions = function (event) {
      coreListener.internalDebugLog('Subscription Is To Terminate On Connection Event ' + event)
      if (uaSubscription && node.stateMachine.getMachineState() === 'STARTED') {
        node.stateMachine.terminatesub()
        uaSubscription.terminate(() => {
          node.stateMachine.idlesub()
          coreListener.internalDebugLog('Subscription Was Terminated On Connector Event ' + event)
        })
      }
    }

    coreListener.core.registerToConnector(node)

    if (node.connector) {
      node.connector.on('connector_init', () => {
        coreListener.internalDebugLog('Reset Subscription On Connector Init')
        uaSubscription = null
        node.monitoredItems = new Map()
        node.monitoredASO = new Map()
        node.stateMachine = coreListener.createStatelyMachine()
        node.monitoredItemGroup = null
      })

      node.connector.on('connection_stopped', () => {
        node.terminateSubscriptions('connection stopped')
      })

      node.connector.on('connection_end', () => {
        node.terminateSubscriptions('connection ends')
      })

      node.connector.on('connection_reconfigure', () => {
        node.terminateSubscriptions('connection reconfigure')
      })

      node.connector.on('connection_renew', () => {
        node.terminateSubscriptions('connection renew')
      })
    }

    node.terminateSubscription = function (done) {
      if (uaSubscription && node.stateMachine.getMachineState() !== 'TERMINATED') {
        node.stateMachine.terminatesub()
        uaSubscription.terminate(() => {
          node.stateMachine.idlesub()
          done()
        })
      } else {
        node.stateMachine.idlesub()
        done()
      }
    }

    node.on('close', function (done) {
      node.terminateSubscription(() => {
        coreListener.core.deregisterToConnector(node, done)
        coreListener.internalDebugLog('Close Listener Node')
      })
    })

    /* #########   FSM EVENTS  #########     */

    node.stateMachine.onIDLE = function (event, oldState, newState) {
      coreListener.detailDebugLog('Listener IDLE Event FSM')
    }

    node.stateMachine.onREQUESTED = function (event, oldState, newState) {
      coreListener.detailDebugLog('Listener REQUESTED Event FSM')
    }

    node.stateMachine.onINIT = function (event, oldState, newState) {
      coreListener.detailDebugLog('Listener INIT Event FSM')
    }

    node.stateMachine.onSTARTED = function (event, oldState, newState) {
      coreListener.detailDebugLog('Listener STARTED Event FSM')

      switch (node.action) {
        case 'subscribe':
          while (node.messageQueue.length > 0) {
            node.subscribeMonitoredItem(node.messageQueue.shift())
          }
          break
        case 'events':
          while (node.messageQueue.length > 0) {
            node.subscribeMonitoredEvent(node.messageQueue.shift())
          }
          break
        default:
          coreListener.internalDebugLog('Unknown Action Type ' + node.action)
      }
    }

    node.stateMachine.onTERMINATED = function (event, oldState, newState) {
      coreListener.detailDebugLog('Listener TERMINATED Event FSM')
    }

    node.stateMachine.onERROR = function (event, oldState, newState) {
      coreListener.detailDebugLog('Listener ERROR Event FSM')
    }

    node.stateMachine.onEND = function (event, oldState, newState) {
      coreListener.detailDebugLog('Listener END Event FSM')
    }
  }

  RED.nodes.registerType('OPCUA-IIoT-Listener', OPCUAIIoTListener)
}
