/*
 * Copyright 2016 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of iotagent-ul
 *
 * iotagent-ul is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * iotagent-ul is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with iotagent-ul.
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[iot_support@tid.es]
 *
 * Modified by: Daniel Calvo - ATOS Research & Innovation
 */

/* eslint-disable no-prototype-builtins */

const iotAgentLib = require('iotagent-node-lib');
const regenerateTransid = iotAgentLib.regenerateTransid;
const intoTrans = iotAgentLib.intoTrans;
const finishSouthBoundTransaction = iotAgentLib.finishSouthBoundTransaction;
const fillService = iotAgentLib.fillService;
const _ = require('underscore');
const commandHandler = require('./commandHandler');
const transportSelector = require('./transportSelector');
const async = require('async');
const iotaUtils = require('./iotaUtils');
const constants = require('./constants');
let context = {
    op: 'IoTAgentJSON.commonBinding'
};
const config = require('./configService');

/**
 * Parse a message received from a Topic.
 *
 * @param {Buffer} message          Message to be parsed
 * @return {Object}                 Parsed message or null if an error has occurred.
 */
function parseMessage(message) {
    let parsedMessage;
    let messageArray;
    context = fillService(context, { service: 'n/a', subservice: 'n/a' });
    const stringMessage = message.toString();
    try {
        parsedMessage = JSON.parse(stringMessage);
    } catch (e) {
        parsedMessage = message.toString('hex');
    }
    config.getLogger().debug(context, 'stringMessage: %s parsedMessage: %s', stringMessage, parsedMessage);
    messageArray = [];
    if (Array.isArray(parsedMessage)) {
        messageArray = parsedMessage;
    } else {
        messageArray.push(parsedMessage);
    }

    config.getLogger().debug(context, 'parserMessage array: %s', messageArray);
    return messageArray;
}

/**
 * Find the attribute given by its name between all the active attributes of the given device, returning its type, or
 * null otherwise.
 *
 * @param {String}      attribute   Name of the attribute to find.
 * @param {Object}      device      Device object containing all the information about a device.
 * @param {measureType} type        Type of measure attribute according with measure when available (ngsiv2 and ngsild measures)
 * @return {String}                 String identifier of the attribute type.
 */
function guessType(attribute, device, measureType) {
    if (device.active) {
        for (let i = 0; i < device.active.length; i++) {
            if (device.active[i].name === attribute) {
                return device.active[i].type;
            }
        }
    }

    if (attribute === constants.TIMESTAMP_ATTRIBUTE) {
        return constants.TIMESTAMP_TYPE_NGSI2;
    }
    if (measureType) {
        return measureType;
    } else {
        return constants.DEFAULT_ATTRIBUTE_TYPE;
    }
}

function extractAttributes(device, current, payloadType) {
    let values = [];

    const ctxt = fillService(context, device);
    config.getLogger().debug(ctxt, 'extractAttributes current %j payloadType %j', current, payloadType);

    if (payloadType && [constants.PAYLOAD_NGSIv2, constants.PAYLOAD_NGSILD].includes(payloadType.toLowerCase())) {
        let arrayEntities = [];
        if (current.hasOwnProperty('actionType') && current.hasOwnProperty('entities')) {
            arrayEntities = current.entities;
        } else {
            arrayEntities = [current];
        }
        for (const entity of arrayEntities) {
            const valuesEntity = [];
            for (const k in entity) {
                if (entity.hasOwnProperty(k)) {
                    if (['id', 'type'].includes(k)) {
                        // Include ngsi id and type as measures by inserting here as is
                        // and later in iota-node-lib sendUpdateValueNgsi2 rename as measure_X
                        valuesEntity.push({
                            name: k,
                            type: guessType(k, device, null),
                            value: entity[k]
                        });
                    } else {
                        if (payloadType.toLowerCase() === constants.PAYLOAD_NGSIv2) {
                            valuesEntity.push({
                                name: k,
                                type: guessType(k, device, entity[k].type),
                                value: entity[k].value,
                                metadata: entity[k].metadata ? entity[k].metadata : undefined
                            });
                        } else if (payloadType.toLowerCase() === constants.PAYLOAD_NGSILD) {
                            const ent = {
                                name: k
                            };
                            if (k.toLowerCase() === '@context') {
                                ent.type = '@context';
                                ent.value = entity[k];
                            } else {
                                if (entity[k].type) {
                                    ent.type = guessType(k, device, entity[k].type);
                                    if (['property', 'geoproperty'].includes(entity[k].type.toLowerCase())) {
                                        ent.value = entity[k].value;
                                    } else if (entity[k].type.toLowerCase() === 'relationship') {
                                        ent.value = entity[k].object;
                                    }
                                }
                                // Add other stuff as metadata
                                for (const key in entity[k]) {
                                    if (!['type', 'value', 'object'].includes(key.toLowerCase())) {
                                        if (!ent.metadata) {
                                            ent.metadata = {};
                                        }
                                        ent.metadata[key] = { value: entity[k][key] };
                                    }
                                }
                            }
                            valuesEntity.push(ent);
                        }
                    }
                }
            }
            if (arrayEntities.length > 1) {
                values.push(valuesEntity); // like a multimeasure
            } else {
                values = valuesEntity;
            }
        }
    } else {
        for (const k in current) {
            if (current.hasOwnProperty(k)) {
                values.push({
                    name: k,
                    type: guessType(k, device, null),
                    value: current[k]
                });
            }
        }
    }
    return values;
}

function sendConfigurationToDevice(device, apiKey, group, deviceId, results, callback) {
    iotAgentLib.getConfigurationSilently(config.getConfig().iota.defaultResource || '', apiKey, function (
        error,
        foundGroup
    ) {
        if (!error) {
            group = foundGroup;
        }
        transportSelector.applyFunctionFromBinding(
            [apiKey, group, deviceId, results],
            'sendConfigurationToDevice',
            device.transport || group.transport || config.getConfig().defaultTransport,
            callback
        );
    });
}

/**
 * Deals with configuration requests coming from the device. Whenever a new configuration requests arrives with a list
 * of attributes to retrieve, this handler asks the Context Broker for the values of those attributes, and publish a
 * new message in the "/1234/MQTT_2/configuration/values" topic
 *
 * @param {String} deviceId         Id of the device to be updated.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Object} objMessage          Array of JSON object received.
 */

//API Key removed
function manageConfigurationRequest(deviceId, device, objMessage) {
    const ctxt = fillService(context, device);
    for (let i = 0; i < objMessage.length; i++) {
        iotaUtils.manageConfiguration(
            deviceId,
            device,
            objMessage[i],
            async.apply(sendConfigurationToDevice, device),
            function (error) {
                if (error) {
                    iotAgentLib.alarms.raise(constants.MQTTB_ALARM, error);
                } else {
                    iotAgentLib.alarms.release(constants.MQTTB_ALARM);
                    config.getLogger().debug(ctxt, 'Configuration request finished for Device %s', deviceId);
                }
                finishSouthBoundTransaction(null);
            }
        );
    }
}

/**
 * Adds a single measure to the context broker. The message for single measures contains the direct value to
 * be inserted in the attribute, given by its name.
 *
 *
 * @param {String} deviceId         Id of the device to be updated.
 * @param {String} attribute        Name of the attribute to update.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Object} parsedMessage    ParsedMessage (JSON or string) message coming from the client.
 */

//API key removed
function singleMeasure(deviceId, attribute, device, parsedMessage) {
    context = fillService(context, device);

    // Log device and attribute information before updating
    config
        .getLogger()
        .debug(
            context,
            `singleMeasure -> deviceId: ${deviceId}, attribute: ${attribute}, parsedMessage: ${JSON.stringify(
                parsedMessage
            )}`
        );

    const values = [
        {
            name: attribute,
            type: guessType(attribute, device, null),
            value: parsedMessage[0]
        }
    ];

    config.getLogger().debug(context, `Values to update: ${JSON.stringify(values)}`);

    iotAgentLib.update(deviceId, device.type, '', values, device, function (error) {
        if (error) {
            config
                .getLogger()
                .error(
                    context,
                    `MEASURES-002: Couldn't send the updated values to the Context Broker due to an error: ${JSON.stringify(
                        error
                    )}`
                );
        } else {
            config
                .getLogger()
                .debug(
                    context,
                    `Single measure for device ${deviceId} successfully updated with attribute ${attribute}`
                );
        }
        finishSouthBoundTransaction(null);
    });
}

/**
 * Adds multiple measures to the Context Broker. Multiple measures come in the form of single-level JSON objects,
 * whose keys are the attribute names and whose values are the attribute values.
 *
 * @param {String} deviceId         Id of the device to be updated.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Object} messageObj       Array of JSON object sent using.
 */

//API Key removed
function multipleMeasures(deviceId, device, messageObj) {
    let measure;
    const ctxt = fillService(context, device);
    config.getLogger().debug(context, 'Processing multiple measures for device %s', deviceId);

    for (let j = 0; j < messageObj.length; j++) {
        measure = messageObj[j];
        let attributesArray = [];
        const values = extractAttributes(device, measure, device.payloadType);
        attributesArray = Array.isArray(values[0]) ? values : [values];

        config
            .getLogger()
            .debug(context, 'Processing multiple measures for device %s values %j', deviceId, attributesArray);
        iotAgentLib.update(deviceId, device.type, '', attributesArray, device, function (error) {
            if (error) {
                config
                    .getLogger()
                    .error(
                        ctxt,
                        "MEASURES-002: Couldn't send the updated values to the Context Broker due to an error: %j",
                        error
                    );
            } else {
                config.getLogger().info(ctxt, 'Multiple measures for device %s successfully updated', deviceId);
            }
            finishSouthBoundTransaction(null);
        });
    }
}

/**
 * Handles an incoming message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attrs[/<attributeName>]'.
 * @param {Object} message      message body (Object or Buffer, depending on the value).
 */

//Changes for topic stucture like this = "bp/{sensor_type}/{device_id}/{data_id}/{attribute}"
function messageHandler(topic, message) {
    if (topic[0] !== '/') {
        topic = '/' + topic;
    }
    const topicInformation = topic.split('/');

    // Extract specific parts of the topic
    const sensorType = topicInformation[1];
    const deviceId = topicInformation[3]; // e.g., "emeter-313"
    const attribute = topicInformation[5]; // e.g., "Phase3Current"
    const parsedMessage = parseMessage(message);

    // Log the extracted topic information for debugging
    config.getLogger().debug(context, `Received message on topic: ${topic}`);
    config
        .getLogger()
        .debug(
            context,
            `Extracted values -> sensorType: ${sensorType}, deviceId: ${deviceId}, attribute: ${attribute}`
        );
    config.getLogger().debug(context, `Parsed message content: ${JSON.stringify(parsedMessage)}`);

    // Function to process message for a specific device
    function processMessageForDevice(device) {
        config.getLogger().debug(context, `Processing message for device: ${JSON.stringify(device)}`);

        if (topicInformation[3] === 'configuration' && topicInformation[4] === 'commands' && parsedMessage) {
            manageConfigurationRequest(deviceId, device, parsedMessage);
        } else if (attribute) {
            // Log before calling singleMeasure
            config
                .getLogger()
                .debug(
                    context,
                    `Calling singleMeasure with -> deviceId: ${deviceId}, attribute: ${attribute}, value: ${parsedMessage[0]}`
                );
            singleMeasure(deviceId, attribute, device, parsedMessage);
        } else if (parsedMessage && Array.isArray(parsedMessage) && parsedMessage.every((x) => typeof x === 'object')) {
            config.getLogger().debug(context, `Calling multipleMeasures for deviceId: ${deviceId}`);
            multipleMeasures(deviceId, device, parsedMessage);
        } else {
            context = fillService(context, device);
            config
                .getLogger()
                .error(
                    context,
                    `Couldn't process message ${message} for device ${JSON.stringify(device)} due to format issues.`
                );
        }
    }

    // Retrieve device information and handle errors
    function processDeviceMeasure(error, device) {
        if (error) {
            context = fillService(context, { service: 'n/a', subservice: 'n/a' });
            config.getLogger().warn(context, `Device not found for topic ${topic}`);
        } else {
            const localContext = _.clone(context);
            localContext.service = device.service;
            localContext.subservice = device.subservice;
            config.getLogger().debug(localContext, `Found device for processing: ${JSON.stringify(device)}`);
            intoTrans(localContext, processMessageForDevice)(device);
        }
    }

    iotAgentLib.alarms.release(constants.MQTTB_ALARM);
    iotaUtils.retrieveDevice(deviceId, processDeviceMeasure);
}

/**
 * Handles an incoming AMQP message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the AMQP topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attributes[/<attributeName>]'.
 * @param {Object} message      AMQP message body (Object or Buffer, depending on the value).
 */
function amqpMessageHandler(topic, message) {
    regenerateTransid(topic);
    messageHandler(topic, message);
}

/**
 * Handles an incoming MQTT message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the MQTT topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attributes[/<attributeName>]'.
 * @param {Object} message      MQTT message body (Object or Buffer, depending on the value).
 */
function mqttMessageHandler(topic, message) {
    regenerateTransid(topic);
    config.getLogger().debug(context, 'message topic: %s', topic);
    messageHandler(topic, message);
}

exports.amqpMessageHandler = amqpMessageHandler;
exports.mqttMessageHandler = mqttMessageHandler;
exports.messageHandler = messageHandler;
exports.extractAttributes = extractAttributes;
exports.guessType = guessType;
